import { env } from "../../../config/env";
import type { AIProvider } from "../interfaces/ai-provider.interface";
import { NoneAIProvider } from "./none.provider";

/**
 * Selects an AIProvider implementation based on `AI_PROVIDER`. Additional
 * providers (Anthropic, OpenAI, ...) register themselves here in a later
 * phase — feature services never import a provider directly.
 */
export function getAIProvider(): AIProvider {
  switch (env.ai.provider) {
    case "none":
    default:
      return new NoneAIProvider();
  }
}
