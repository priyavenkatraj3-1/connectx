/**
 * Low-level, vendor-neutral abstraction over a generative AI provider.
 * Feature code never talks to a provider directly: it goes through
 * AIGateway (../ai.gateway.ts), which adds timeouts, retries, per-user
 * limits, usage logging and output validation on top of this interface.
 *
 * One `generate` call covers every text capability ConnectX needs — chat
 * answers, summarization, classification, translation and structured
 * extraction are all "system prompt + bounded input → text or JSON". Adding
 * a vendor means implementing this interface and registering it in
 * providers/provider.factory.ts.
 */
export interface AIGenerateRequest {
  /** Trusted, application-authored instructions. */
  system: string;
  /** The user turn: task instructions plus clearly delimited untrusted data (see context/prompt-safety.ts). */
  input: string;
  maxOutputTokens: number;
  /**
   * When set, the provider must return one JSON object that matches this
   * JSON Schema. Providers that can constrain output natively should; the
   * gateway validates the result either way and never trusts it blindly.
   */
  jsonSchema?: Record<string, unknown>;
  signal: AbortSignal;
}

export interface AIGenerateResult {
  text: string;
  /** Model that actually produced the output (may differ from the configured one after a server-side fallback). */
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  /** True when the output hit the token limit and may be cut off. */
  truncated: boolean;
}

export interface AIProvider {
  readonly name: string;
  readonly isConfigured: boolean;
  /** Configured model id, or null when unconfigured. */
  readonly model: string | null;
  generate(request: AIGenerateRequest): Promise<AIGenerateResult>;
}

export interface TranscriptionRequest {
  audio: Buffer;
  mimeType: string;
  filename: string;
  /** Optional ISO-639-1 hint, e.g. "en". */
  languageHint?: string;
  signal: AbortSignal;
}

export interface TranscriptionResult {
  text: string;
  detectedLanguage: string | null;
}

/** Speech-to-text is a separate provider: many text-generation vendors don't offer it, and vice versa. */
export interface TranscriptionProvider {
  readonly name: string;
  readonly isConfigured: boolean;
  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult>;
}

/**
 * What providers throw. `retryable` drives the gateway's retry policy;
 * `code` is logged (never the message content) and mapped to a safe,
 * client-facing error by the gateway.
 */
export class ProviderCallError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "timeout"
      | "aborted"
      | "rate_limited"
      | "overloaded"
      | "network"
      | "auth"
      | "bad_request"
      | "refused"
      | "not_configured"
      | "invalid_response"
      | "unknown",
    public readonly retryable: boolean
  ) {
    super(message);
  }
}
