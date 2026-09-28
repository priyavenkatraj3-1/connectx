import { z } from "zod";
import {
  ProviderCallError,
  type TranscriptionProvider,
  type TranscriptionRequest,
  type TranscriptionResult,
} from "../interfaces/ai-provider.interface";

export interface WhisperHttpOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
}

const responseSchema = z.object({
  text: z.string(),
  language: z.string().max(32).optional(),
});

/**
 * Speech-to-text over the widely implemented Whisper-style HTTP API:
 * `POST {baseUrl}/audio/transcriptions` (multipart: file, model, language).
 * Works with self-hosted Whisper servers as well as hosted services that
 * expose this shape. Uses Node's built-in fetch/FormData — no extra
 * dependency. Not exercised against a live endpoint by the test suite.
 */
export class WhisperHttpTranscriptionProvider implements TranscriptionProvider {
  readonly name = "whisper-http";
  readonly isConfigured = true;

  constructor(private readonly options: WhisperHttpOptions) {}

  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    const form = new FormData();
    form.append("file", new Blob([request.audio], { type: request.mimeType }), request.filename);
    form.append("model", this.options.model);
    form.append("response_format", "json");
    if (request.languageHint) form.append("language", request.languageHint);

    let response: Response;
    try {
      response = await fetch(`${this.options.baseUrl.replace(/\/+$/, "")}/audio/transcriptions`, {
        method: "POST",
        headers: this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {},
        body: form,
        signal: request.signal,
      });
    } catch (err) {
      if (request.signal.aborted) throw new ProviderCallError("Transcription aborted", "aborted", false);
      throw new ProviderCallError(err instanceof Error ? err.message : "Transcription request failed", "network", true);
    }

    if (!response.ok) {
      if (response.status === 429) throw new ProviderCallError("Transcription rate limited", "rate_limited", true);
      if (response.status === 401 || response.status === 403) throw new ProviderCallError("Transcription auth failed", "auth", false);
      if (response.status >= 500) throw new ProviderCallError("Transcription service error", "overloaded", true);
      throw new ProviderCallError("Transcription request rejected", "bad_request", false);
    }

    const parsed = responseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new ProviderCallError("Malformed transcription response", "invalid_response", false);
    return { text: parsed.data.text.trim(), detectedLanguage: parsed.data.language ?? null };
  }
}
