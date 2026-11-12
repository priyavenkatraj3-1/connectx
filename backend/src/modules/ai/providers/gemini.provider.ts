import { ApiError, BlockedReason, FinishReason, GoogleGenAI, type GenerateContentConfig, type GenerateContentResponse } from "@google/genai";
import {
  type AIGenerateRequest,
  type AIGenerateResult,
  type AIProvider,
  ProviderCallError,
} from "../interfaces/ai-provider.interface";

export interface GeminiProviderOptions {
  apiKey: string;
  model: string;
}

/** Finish reasons meaning Google's safety systems withheld the output (surfaced as `422 ai_refused`). */
export const REFUSAL_FINISH_REASONS: ReadonlySet<string> = new Set([
  FinishReason.SAFETY,
  FinishReason.RECITATION,
  FinishReason.BLOCKLIST,
  FinishReason.PROHIBITED_CONTENT,
  FinishReason.SPII,
]);

/** The part of the SDK client this provider uses; injectable so tests never construct a real client. */
export interface GeminiModelsClient {
  generateContent(params: { model: string; contents: unknown; config?: GenerateContentConfig }): Promise<GenerateContentResponse>;
}

/**
 * Google Gemini implementation of AIProvider, using the official
 * `@google/genai` SDK (Gemini Developer API, not Vertex AI).
 *
 * Like the Anthropic provider, it is only a transport: consent, chat
 * exclusions, prompt safety, rate limits, timeouts, retries and output
 * validation all happen before or after it, in the feature services and
 * AIGateway. The SDK's own retries are disabled so the gateway's retry
 * policy is the only one.
 *
 * The API key is passed explicitly (so the SDK never falls back to other
 * environment variables) and is never included in logs or error messages.
 */
export class GeminiProvider implements AIProvider {
  readonly name = "gemini";
  readonly isConfigured = true;
  readonly model: string;
  /**
   * The SDK client keeps the API key in its options. A true `#private` field
   * is skipped by JSON.stringify and util.inspect, so logging or serializing
   * this provider can never print the key.
   */
  readonly #models: GeminiModelsClient;

  constructor(options: GeminiProviderOptions, models?: GeminiModelsClient) {
    this.model = options.model;
    this.#models =
      models ??
      new GoogleGenAI({
        apiKey: options.apiKey,
        vertexai: false, // ignore GOOGLE_GENAI_USE_VERTEXAI etc.; this provider is the Gemini Developer API only
        httpOptions: { retryOptions: { attempts: 1 } }, // 1 = no SDK retries; AIGateway owns retries
      }).models;
  }

  async generate(request: AIGenerateRequest): Promise<AIGenerateResult> {
    const config: GenerateContentConfig = {
      systemInstruction: request.system,
      maxOutputTokens: request.maxOutputTokens,
      abortSignal: request.signal,
    };
    if (request.jsonSchema) {
      config.responseMimeType = "application/json";
      config.responseJsonSchema = toGeminiJsonSchema(request.jsonSchema);
    }

    let response: GenerateContentResponse;
    try {
      response = await this.#models.generateContent({
        model: this.model,
        contents: [{ role: "user", parts: [{ text: request.input }] }],
        config,
      });
    } catch (err) {
      throw toProviderError(err, request.signal);
    }

    const blockReason = response.promptFeedback?.blockReason;
    if (blockReason && blockReason !== BlockedReason.BLOCKED_REASON_UNSPECIFIED) {
      throw new ProviderCallError("The model declined the request", "refused", false);
    }
    const candidate = response.candidates?.[0];
    const finishReason = candidate?.finishReason;
    if (finishReason && REFUSAL_FINISH_REASONS.has(finishReason)) {
      throw new ProviderCallError("The model declined the request", "refused", false);
    }

    // Read text parts directly (skipping thought summaries) rather than `response.text`, which warns on mixed parts.
    const text = (candidate?.content?.parts ?? [])
      .filter((part) => typeof part.text === "string" && !part.thought)
      .map((part) => part.text)
      .join("");

    return {
      text,
      model: response.modelVersion ?? this.model,
      inputTokens: response.usageMetadata?.promptTokenCount ?? null,
      outputTokens: response.usageMetadata?.candidatesTokenCount ?? null,
      truncated: finishReason === FinishReason.MAX_TOKENS,
    };
  }
}

/**
 * ConnectX's feature schemas mark nullable fields as `type: ["string", "null"]`.
 * Gemini's documented JSON Schema subset lists `anyOf` but not array-valued
 * `type`, so those become the equivalent `anyOf`. Everything else passes
 * through unchanged; the gateway re-validates the output with zod either way.
 * Exported for tests.
 */
export function toGeminiJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiJsonSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === "type" && Array.isArray(value)) continue;
    out[key] = toGeminiJsonSchema(value);
  }
  const type = (schema as Record<string, unknown>).type;
  if (Array.isArray(type)) {
    if (type.length === 1) out.type = type[0];
    else out.anyOf = type.map((entry) => ({ type: entry }));
  }
  return out;
}

/** Maps SDK and network failures to vendor-neutral ProviderCallErrors with fixed messages (never Google's text, which could echo request data). */
export function toProviderError(err: unknown, signal: AbortSignal): ProviderCallError {
  if (signal.aborted || (err instanceof Error && err.name === "AbortError")) {
    return new ProviderCallError("Request aborted", "aborted", false);
  }
  if (err instanceof ApiError) {
    const status = err.status;
    if (status === 429) return new ProviderCallError("Provider rate limit", "rate_limited", true);
    if (status === 401 || status === 403) return new ProviderCallError("Provider rejected the credentials", "auth", false);
    if (status === 400 || status === 404) return new ProviderCallError("Provider rejected the request", "bad_request", false);
    if (status === 408) return new ProviderCallError("Provider timed out", "timeout", true);
    if (status >= 500) return new ProviderCallError("Provider error", "overloaded", true);
    return new ProviderCallError("Provider error", "unknown", false);
  }
  // Node's fetch() rejects with TypeError("fetch failed") when the network is unreachable; other TypeErrors are bugs, not retried.
  if (err instanceof TypeError && /fetch failed/i.test(err.message)) {
    return new ProviderCallError("Provider unreachable", "network", true);
  }
  return new ProviderCallError("Provider call failed", "unknown", false);
}
