import Anthropic from "@anthropic-ai/sdk";
import {
  type AIGenerateRequest,
  type AIGenerateResult,
  type AIProvider,
  ProviderCallError,
} from "../interfaces/ai-provider.interface";

export interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  /** "low" | "medium" | "high"; undefined or "default" omits it. */
  effort?: string;
  /** Opt into the API's server-side refusal fallback (see docs/ai.md). */
  refusalFallback: boolean;
}

const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);

/**
 * Anthropic (Claude) implementation of AIProvider, using the official SDK.
 * The SDK's own retries are disabled — AIGateway owns the retry policy so
 * retries, timeouts and usage logging behave the same for every provider.
 */
export class AnthropicProvider implements AIProvider {
  readonly name = "anthropic";
  readonly isConfigured = true;
  readonly model: string;
  private readonly client: Anthropic;

  constructor(private readonly options: AnthropicProviderOptions) {
    this.model = options.model;
    this.client = new Anthropic({ apiKey: options.apiKey, maxRetries: 0 });
  }

  async generate(request: AIGenerateRequest): Promise<AIGenerateResult> {
    const effort = this.options.effort && EFFORT_LEVELS.has(this.options.effort) ? this.options.effort : undefined;
    const outputConfig: Anthropic.Beta.Messages.BetaOutputConfig = {};
    if (effort) outputConfig.effort = effort as NonNullable<Anthropic.Beta.Messages.BetaOutputConfig["effort"]>;
    if (request.jsonSchema) outputConfig.format = { type: "json_schema", schema: request.jsonSchema };

    let response: Anthropic.Beta.Messages.BetaMessage;
    try {
      response = await this.client.beta.messages.create(
        {
          model: this.model,
          max_tokens: request.maxOutputTokens,
          system: request.system,
          messages: [{ role: "user", content: request.input }],
          ...(Object.keys(outputConfig).length > 0 ? { output_config: outputConfig } : {}),
          ...(this.options.refusalFallback
            ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
            : {}),
        },
        { signal: request.signal }
      );
    } catch (err) {
      throw toProviderError(err);
    }

    if (response.stop_reason === "refusal") {
      throw new ProviderCallError("The model declined the request", "refused", false);
    }

    const text = response.content
      .filter((block): block is Anthropic.Beta.Messages.BetaTextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    return {
      text,
      model: response.model,
      inputTokens: response.usage?.input_tokens ?? null,
      outputTokens: response.usage?.output_tokens ?? null,
      truncated: response.stop_reason === "max_tokens",
    };
  }
}

/** Maps SDK errors (typed classes, most specific first) to vendor-neutral ProviderCallErrors. */
function toProviderError(err: unknown): ProviderCallError {
  if (err instanceof Anthropic.APIUserAbortError) return new ProviderCallError("Request aborted", "aborted", false);
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new ProviderCallError("Provider timed out", "timeout", true);
  if (err instanceof Anthropic.APIConnectionError) return new ProviderCallError("Provider unreachable", "network", true);
  if (err instanceof Anthropic.RateLimitError) return new ProviderCallError("Provider rate limit", "rate_limited", true);
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new ProviderCallError("Provider rejected the credentials", "auth", false);
  }
  if (err instanceof Anthropic.BadRequestError || err instanceof Anthropic.NotFoundError) {
    return new ProviderCallError("Provider rejected the request", "bad_request", false);
  }
  if (err instanceof Anthropic.InternalServerError) return new ProviderCallError("Provider error", "overloaded", true);
  if (err instanceof Anthropic.APIError) {
    const retryable = typeof err.status === "number" && (err.status === 408 || err.status === 409 || err.status >= 500);
    return new ProviderCallError("Provider error", "unknown", retryable);
  }
  return new ProviderCallError("Provider call failed", "unknown", false);
}
