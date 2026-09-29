import { env } from "../../../config/env";
import type { AIProvider, TranscriptionProvider } from "../interfaces/ai-provider.interface";
import { AnthropicProvider } from "./anthropic.provider";
import { NoneAIProvider, NoneTranscriptionProvider } from "./none.provider";
import { WhisperHttpTranscriptionProvider } from "./whisper-http.transcription";
import { logger } from "../../../utils/logger";

/**
 * Selects the text-generation provider from `AI_PROVIDER`. Feature services
 * never import a provider directly. An unknown name or a missing key falls
 * back to the unconfigured provider (with a warning) — never to fake output.
 */
export function createAIProvider(config: typeof env.ai = env.ai): AIProvider {
  switch (config.provider) {
    case "anthropic":
      if (!config.apiKey) {
        logger.warn("[ai] AI_PROVIDER=anthropic but AI_PROVIDER_API_KEY is empty — AI features stay unavailable.");
        return new NoneAIProvider();
      }
      return new AnthropicProvider({
        apiKey: config.apiKey,
        model: config.model,
        effort: config.effort === "default" ? undefined : config.effort,
        refusalFallback: config.refusalFallback,
      });
    case "none":
      return new NoneAIProvider();
    default:
      logger.warn(`[ai] Unknown AI_PROVIDER "${config.provider}" — AI features stay unavailable.`);
      return new NoneAIProvider();
  }
}

/** Selects the speech-to-text provider from `TRANSCRIPTION_PROVIDER`. */
export function createTranscriptionProvider(config: typeof env.ai.transcription = env.ai.transcription): TranscriptionProvider {
  switch (config.provider) {
    case "whisper-http":
      if (!config.baseUrl) {
        logger.warn("[ai] TRANSCRIPTION_PROVIDER=whisper-http but TRANSCRIPTION_BASE_URL is empty — transcription stays unavailable.");
        return new NoneTranscriptionProvider();
      }
      return new WhisperHttpTranscriptionProvider({ baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model });
    case "none":
      return new NoneTranscriptionProvider();
    default:
      logger.warn(`[ai] Unknown TRANSCRIPTION_PROVIDER "${config.provider}" — transcription stays unavailable.`);
      return new NoneTranscriptionProvider();
  }
}
