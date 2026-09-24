import type { AIProvider, TextGenerationRequest, TextGenerationResult, TranscriptionRequest, TranscriptionResult } from "../interfaces/ai-provider.interface";

/**
 * Default provider when `AI_PROVIDER=none` (Phase 1 default). Clearly
 * reports itself as unconfigured rather than silently returning fake
 * output, so callers and UI can show an honest "AI not available" state.
 */
export class NoneAIProvider implements AIProvider {
  readonly name = "none";
  readonly isConfigured = false;

  async generateText(_request: TextGenerationRequest): Promise<TextGenerationResult> {
    throw new Error("No AI provider is configured. Set AI_PROVIDER and AI_PROVIDER_API_KEY to enable AI features.");
  }

  async transcribeAudio(_request: TranscriptionRequest): Promise<TranscriptionResult> {
    throw new Error("No AI provider is configured. Set AI_PROVIDER and AI_PROVIDER_API_KEY to enable AI features.");
  }
}
