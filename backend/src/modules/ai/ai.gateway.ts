import type { ZodType } from "zod";
import type { RealtimeGateway } from "../../realtime/gateway.interface";
import { generateId } from "../../utils/id";
import type { AIRateLimiter } from "./ai.rate-limiter";
import type { AIRepository, UsageStatus } from "./ai.repository";
import type { AIFeature } from "./ai.types";
import {
  AIInvalidOutputError,
  AIProviderFailureError,
  AIRefusedError,
  AITimeoutError,
  AIUnavailableError,
} from "./ai.errors";
import {
  type AIProvider,
  ProviderCallError,
  type TranscriptionProvider,
  type TranscriptionResult,
} from "./interfaces/ai-provider.interface";
import { logger } from "../../utils/logger";

export interface AIGatewayOptions {
  timeoutMs: number;
  /** Extra attempts after the first, for retryable failures (network, 429, 5xx, timeout). */
  maxRetries: number;
  /** Hard ceiling on output tokens for any single call. */
  maxOutputTokens: number;
  /** Base backoff between retries; doubled per attempt. Tests set 0. */
  retryBaseDelayMs?: number;
}

export interface GenerateOptions {
  system: string;
  input: string;
  maxOutputTokens?: number;
}

export interface GeneratedBy {
  provider: string;
  model: string;
}

/** Strips a Markdown code fence some models wrap JSON in, then parses. */
export function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const body = fenced ? fenced[1]! : trimmed;
  try {
    return JSON.parse(body);
  } catch {
    // Tolerate leading/trailing prose around a single JSON object.
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start === -1 || end <= start) return undefined;
    try {
      return JSON.parse(body.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The single choke point between ConnectX and any AI provider.
 *
 * Every call: (1) fails fast with a clear "not configured" error when no
 * provider exists, (2) takes a per-user rate-limit slot, (3) runs with a
 * hard timeout and a bounded retry policy, (4) logs metadata-only usage
 * (never content), (5) pushes `ai:*` status events to the requesting user
 * only, and (6) for structured calls, validates output against a Zod
 * schema — malformed provider output becomes a clean 502, never a crash
 * and never unvalidated data.
 *
 * Nothing here is triggered automatically: every call originates from an
 * explicit user request, so there is no path to an AI request loop.
 */
export class AIGateway {
  constructor(
    private readonly provider: AIProvider,
    private readonly transcriptionProvider: TranscriptionProvider,
    private readonly repository: AIRepository,
    private readonly rateLimiter: AIRateLimiter,
    private readonly realtime: RealtimeGateway,
    private readonly options: AIGatewayOptions
  ) {}

  get providerStatus(): { name: string; configured: boolean; model: string | null } {
    return { name: this.provider.name, configured: this.provider.isConfigured, model: this.provider.model };
  }

  get transcriptionStatus(): { name: string; configured: boolean } {
    return { name: this.transcriptionProvider.name, configured: this.transcriptionProvider.isConfigured };
  }

  requireTextProvider(): void {
    if (!this.provider.isConfigured) throw new AIUnavailableError();
  }

  requireTranscriptionProvider(): void {
    if (!this.transcriptionProvider.isConfigured) {
      throw new AIUnavailableError("Voice transcription isn't configured on this server yet.");
    }
  }

  async generateText(userId: string, feature: AIFeature, request: GenerateOptions): Promise<{ text: string } & GeneratedBy> {
    this.requireTextProvider();
    const result = await this.run(userId, feature, this.provider.name, this.provider.model, (signal) =>
      this.provider.generate({
        system: request.system,
        input: request.input,
        maxOutputTokens: this.capTokens(request.maxOutputTokens),
        signal,
      })
    );
    if (!result.text.trim()) throw new AIInvalidOutputError();
    return { text: result.text, provider: this.provider.name, model: result.model };
  }

  /**
   * Structured output: asks the provider for JSON matching `jsonSchema`,
   * then validates it with `schema`. Callers still apply their own
   * semantic checks (e.g. source references must exist) on top.
   */
  async generateStructured<T>(
    userId: string,
    feature: AIFeature,
    request: GenerateOptions & { schema: ZodType<T>; jsonSchema: Record<string, unknown> }
  ): Promise<{ data: T } & GeneratedBy> {
    this.requireTextProvider();
    const result = await this.run(userId, feature, this.provider.name, this.provider.model, (signal) =>
      this.provider.generate({
        system: request.system,
        input: request.input,
        maxOutputTokens: this.capTokens(request.maxOutputTokens),
        jsonSchema: request.jsonSchema,
        signal,
      })
    );
    const parsed = request.schema.safeParse(parseJsonObject(result.text));
    if (!parsed.success) throw new AIInvalidOutputError();
    return { data: parsed.data, provider: this.provider.name, model: result.model };
  }

  async transcribe(
    userId: string,
    request: { audio: Buffer; mimeType: string; filename: string; languageHint?: string }
  ): Promise<TranscriptionResult & { provider: string }> {
    this.requireTranscriptionProvider();
    const result = await this.run(userId, "voice_transcription", this.transcriptionProvider.name, null, async (signal) => {
      const transcription = await this.transcriptionProvider.transcribe({ ...request, signal });
      return { ...transcription, inputTokens: null, outputTokens: null };
    });
    return { text: result.text, detectedLanguage: result.detectedLanguage, provider: this.transcriptionProvider.name };
  }

  private capTokens(requested: number | undefined): number {
    return Math.max(1, Math.min(requested ?? this.options.maxOutputTokens, this.options.maxOutputTokens));
  }

  private async run<T extends { inputTokens: number | null; outputTokens: number | null; model?: string }>(
    userId: string,
    feature: AIFeature,
    providerName: string,
    model: string | null,
    call: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const requestId = generateId();
    try {
      await this.rateLimiter.acquire(userId);
    } catch (err) {
      await this.log(requestId, userId, feature, providerName, model, "rate_limited", "rate_limited", null, null);
      throw err;
    }

    this.realtime.sendToUser(userId, { type: "ai:processing", requestId, feature });
    const startedAt = Date.now();
    let attempt = 0;

    for (;;) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
      try {
        const result = await call(controller.signal);
        clearTimeout(timer);
        await this.log(
          requestId,
          userId,
          feature,
          providerName,
          result.model ?? model,
          "success",
          null,
          result,
          Date.now() - startedAt
        );
        this.realtime.sendToUser(userId, { type: "ai:completed", requestId, feature });
        return result;
      } catch (err) {
        clearTimeout(timer);
        const timedOut = controller.signal.aborted;
        const providerError =
          err instanceof ProviderCallError
            ? err
            : new ProviderCallError(err instanceof Error ? err.message : "Unknown provider failure", "unknown", false);
        const code = timedOut ? "timeout" : providerError.code;
        const retryable = timedOut || providerError.retryable;

        if (retryable && attempt < this.options.maxRetries) {
          attempt += 1;
          const delay = (this.options.retryBaseDelayMs ?? 500) * 2 ** (attempt - 1);
          if (delay > 0) await sleep(delay);
          continue;
        }

        await this.log(
          requestId,
          userId,
          feature,
          providerName,
          model,
          timedOut ? "timeout" : "error",
          code,
          null,
          Date.now() - startedAt
        );
        this.realtime.sendToUser(userId, { type: "ai:failed", requestId, feature, code });
        // Provider details stay in the server log; clients get a generic, coded error.
        logger.warn(`[ai] ${feature} failed for request ${requestId}: ${code}`);
        if (timedOut || code === "timeout") throw new AITimeoutError();
        if (code === "refused") throw new AIRefusedError();
        if (code === "not_configured") throw new AIUnavailableError();
        throw new AIProviderFailureError();
      }
    }
  }

  private async log(
    id: string,
    userId: string,
    feature: AIFeature,
    provider: string,
    model: string | null,
    status: UsageStatus,
    errorCode: string | null,
    usage: { inputTokens: number | null; outputTokens: number | null } | null,
    latencyMs: number | null = null
  ): Promise<void> {
    try {
      await this.repository.recordUsage({
        id,
        userId,
        feature,
        provider,
        model,
        status,
        errorCode,
        inputTokens: usage?.inputTokens ?? null,
        outputTokens: usage?.outputTokens ?? null,
        latencyMs,
      });
    } catch (err) {
      // Usage logging must never break the feature itself.
      logger.error("[ai] failed to record usage", err);
    }
  }
}
