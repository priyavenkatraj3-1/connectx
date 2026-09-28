import {
  type AIGenerateRequest,
  type AIGenerateResult,
  type AIProvider,
  ProviderCallError,
  type TranscriptionProvider,
  type TranscriptionRequest,
  type TranscriptionResult,
} from "../../src/modules/ai/interfaces/ai-provider.interface";

type Step = (request: AIGenerateRequest) => Promise<AIGenerateResult> | AIGenerateResult;

/**
 * TEST DOUBLE ONLY. Returns responses a test scripted in advance so the
 * provider-independent logic around a provider (authorization, prompt
 * construction, output validation, source mapping, retries, timeouts) can
 * be tested without a real AI service. It is never wired into the app —
 * production uses providers/provider.factory.ts, which falls back to the
 * honest "not configured" provider.
 */
export class ScriptedAIProvider implements AIProvider {
  readonly name = "scripted-test";
  readonly isConfigured = true;
  readonly model = "scripted-model";
  readonly calls: AIGenerateRequest[] = [];
  private readonly steps: Step[] = [];

  /** Next call returns this JSON (object) or raw text (string); a function can build it from the request. */
  respond(output: unknown | ((request: AIGenerateRequest) => unknown)): this {
    this.steps.push((request) => {
      const value = typeof output === "function" ? (output as (r: AIGenerateRequest) => unknown)(request) : output;
      return {
        text: typeof value === "string" ? value : JSON.stringify(value),
        model: this.model,
        inputTokens: 100,
        outputTokens: 20,
        truncated: false,
      };
    });
    return this;
  }

  fail(error: ProviderCallError = new ProviderCallError("boom", "overloaded", true)): this {
    this.steps.push(() => {
      throw error;
    });
    return this;
  }

  /** Never resolves until the request is aborted (simulates a hung provider). */
  hang(): this {
    this.steps.push(
      (request) =>
        new Promise<AIGenerateResult>((_, reject) => {
          request.signal.addEventListener("abort", () => reject(new ProviderCallError("aborted", "aborted", false)));
        })
    );
    return this;
  }

  get pending(): number {
    return this.steps.length;
  }

  async generate(request: AIGenerateRequest): Promise<AIGenerateResult> {
    this.calls.push(request);
    const step = this.steps.shift();
    if (!step) throw new Error("ScriptedAIProvider: unexpected call with no scripted response");
    return step(request);
  }
}

export class ScriptedTranscriptionProvider implements TranscriptionProvider {
  readonly name = "scripted-stt";
  readonly isConfigured = true;
  readonly calls: TranscriptionRequest[] = [];
  private readonly results: Array<TranscriptionResult | ProviderCallError> = [];

  respond(text: string, detectedLanguage: string | null = "en"): this {
    this.results.push({ text, detectedLanguage });
    return this;
  }

  fail(error = new ProviderCallError("stt down", "bad_request", false)): this {
    this.results.push(error);
    return this;
  }

  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    this.calls.push(request);
    const next = this.results.shift();
    if (!next) throw new Error("ScriptedTranscriptionProvider: unexpected call");
    if (next instanceof ProviderCallError) throw next;
    return next;
  }
}

/** Finds the prompt ref ("M3") assigned to the message whose text contains `snippet`. */
export function refFor(request: AIGenerateRequest, snippet: string): string {
  for (const line of request.input.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as { ref?: string; text?: string };
      if (parsed.ref && parsed.text?.includes(snippet)) return parsed.ref;
    } catch {
      // not a data line
    }
  }
  throw new Error(`No message containing "${snippet}" in the prompt`);
}
