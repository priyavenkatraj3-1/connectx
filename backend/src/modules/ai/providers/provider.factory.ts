import { env } from "../../../config/env";
import type { AIProvider, TranscriptionProvider } from "../interfaces/ai-provider.interface";
import { AnthropicProvider } from "./anthropic.provider";
import { GeminiProvider } from "./gemini.provider";
import { GeminiTranscriptionProvider } from "./gemini.transcription";
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
    case "gemini":
      // Only presence is ever logged — never the key itself.
      if (!config.gemini.apiKey) {
        logger.warn("[ai] AI_PROVIDER=gemini but GEMINI_API_KEY is empty — AI features stay unavailable.");
        return new NoneAIProvider();
      }
      if (!config.gemini.model) {
        logger.warn("[ai] AI_PROVIDER=gemini but GEMINI_MODEL is empty — AI features stay unavailable.");
        return new NoneAIProvider();
      }
      return new GeminiProvider({ apiKey: config.gemini.apiKey, model: config.gemini.model });
    case "none":
      return new NoneAIProvider();
    default:
      logger.warn(`[ai] Unknown AI_PROVIDER "${config.provider}" — AI features stay unavailable.`);
      return new NoneAIProvider();
  }
}

/**
 * Selects the speech-to-text provider from `TRANSCRIPTION_PROVIDER`.
 * "gemini" reuses GEMINI_API_KEY and needs a model (GEMINI_TRANSCRIPTION_MODEL,
 * else GEMINI_MODEL); with either missing, transcription stays unavailable.
 */
export function createTranscriptionProvider(
  config: typeof env.ai.transcription = env.ai.transcription,
  gemini: typeof env.ai.gemini = env.ai.gemini
): TranscriptionProvider {
  switch (config.provider) {
    case "gemini": {
      const model = config.geminiModel ?? gemini.model;
      if (!gemini.apiKey) {
        logger.warn("[ai] TRANSCRIPTION_PROVIDER=gemini but GEMINI_API_KEY is empty — transcription stays unavailable.");
        return new NoneTranscriptionProvider();
      }
      if (!model) {
        logger.warn(
          "[ai] TRANSCRIPTION_PROVIDER=gemini but neither GEMINI_TRANSCRIPTION_MODEL nor GEMINI_MODEL is set — transcription stays unavailable."
        );
        return new NoneTranscriptionProvider();
      }
      return new GeminiTranscriptionProvider({ apiKey: gemini.apiKey, model });
    }
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
