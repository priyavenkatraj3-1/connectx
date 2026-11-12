import type { AISettings, AISettingsResponse } from "../types/ai";

/** A GET /ai/settings response. Defaults: everything on and a configured provider; override per test. */
export function aiSettingsResponse(
  settings: Partial<AISettings> = {},
  server: { providerConfigured?: boolean; transcriptionConfigured?: boolean } = {}
): AISettingsResponse {
  return {
    settings: {
      aiFeaturesEnabled: true,
      aiMemoryEnabled: true,
      chatRetrievalEnabled: true,
      spamShieldEnabled: true,
      voiceEnabled: true,
      preferredLanguage: "es",
      consentedAt: new Date().toISOString(),
      ...settings,
    },
    provider: {
      name: server.providerConfigured === false ? "none" : "anthropic",
      configured: server.providerConfigured !== false,
      model: server.providerConfigured === false ? null : "claude-opus-5",
    },
    transcription: {
      name: server.transcriptionConfigured ? "whisper-http" : "none",
      configured: !!server.transcriptionConfigured,
    },
    supportedLanguages: [
      { code: "en", name: "English" },
      { code: "es", name: "Spanish" },
    ],
    voiceTranslationLanguages: [
      { code: "ta", name: "Tamil" },
      { code: "en", name: "English" },
      { code: "hi", name: "Hindi" },
      { code: "te", name: "Telugu" },
      { code: "ml", name: "Malayalam" },
    ],
    dataSharing: ["Translation sends only the one message you ask to translate."],
  };
}
