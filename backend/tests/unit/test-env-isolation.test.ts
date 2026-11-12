import { describe, expect, it } from "vitest";
import { env } from "../../src/config/env";
import { createAIProvider, createTranscriptionProvider } from "../../src/modules/ai/providers/provider.factory";

/**
 * vitest.config.ts shadows backend/.env so the suite can never reach a real
 * AI or speech-to-text provider (or spend the developer's API quota), even
 * when backend/.env configures one. Tests that need a provider inject a
 * scripted or mocked one.
 */
describe("test environment isolation", () => {
  it("never configures a real AI provider from backend/.env", () => {
    expect(env.ai.provider).toBe("none");
    expect(env.ai.apiKey).toBeUndefined();
    expect(env.ai.gemini).toEqual({ apiKey: undefined, model: undefined });
    expect(createAIProvider().isConfigured).toBe(false);
  });

  it("never configures a real transcription provider from backend/.env", () => {
    expect(env.ai.transcription).toMatchObject({ provider: "none", baseUrl: undefined, apiKey: undefined, geminiModel: undefined });
    expect(createTranscriptionProvider().isConfigured).toBe(false);
  });
});
