import {
  type AIGenerateResult,
  type AIProvider,
  ProviderCallError,
  type TranscriptionProvider,
  type TranscriptionResult,
} from "../interfaces/ai-provider.interface";

/**
 * Default when `AI_PROVIDER=none`. Reports itself as unconfigured and
 * throws instead of returning fabricated output, so the API and UI can show
 * an honest "AI not configured" state. The gateway checks `isConfigured`
 * first, so these methods are a last line of defense.
 */
export class NoneAIProvider implements AIProvider {
  readonly name = "none";
  readonly isConfigured = false;
  readonly model = null;

  async generate(): Promise<AIGenerateResult> {
    throw new ProviderCallError("No AI provider is configured", "not_configured", false);
  }
}

export class NoneTranscriptionProvider implements TranscriptionProvider {
  readonly name = "none";
  readonly isConfigured = false;

  async transcribe(): Promise<TranscriptionResult> {
    throw new ProviderCallError("No transcription provider is configured", "not_configured", false);
  }
}
