/**
 * Low-level abstraction over a generative AI provider (e.g. Anthropic,
 * OpenAI, or a self-hosted model). Every higher-level AI service in this
 * module (chat assistant, summarization, translation, etc.) is written
 * against this interface — never against a specific vendor SDK — so the
 * provider can be swapped or made multi-provider without touching feature
 * logic.
 *
 * Phase 1 ships no live implementation; see `providers/none.provider.ts`.
 */
export interface TextGenerationRequest {
  prompt: string;
  systemPrompt?: string;
  maxOutputTokens?: number;
}

export interface TextGenerationResult {
  text: string;
  providerName: string;
}

export interface TranscriptionRequest {
  audio: Buffer;
  mimeType: string;
  languageHint?: string;
}

export interface TranscriptionResult {
  text: string;
  detectedLanguage?: string;
}

export interface AIProvider {
  readonly name: string;
  readonly isConfigured: boolean;

  generateText(request: TextGenerationRequest): Promise<TextGenerationResult>;
  transcribeAudio(request: TranscriptionRequest): Promise<TranscriptionResult>;
}
