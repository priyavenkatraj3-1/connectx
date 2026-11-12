import type { Express } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app";
import type { DatabaseClient } from "../../src/db/pool";
import type { AIProvider } from "../../src/modules/ai/interfaces/ai-provider.interface";
import { ProviderCallError } from "../../src/modules/ai/interfaces/ai-provider.interface";
import { type GeminiModelsClient, GeminiProvider } from "../../src/modules/ai/providers/gemini.provider";
import { GEMINI_INLINE_AUDIO_MAX_BYTES, GeminiTranscriptionProvider } from "../../src/modules/ai/providers/gemini.transcription";
import { NoneAIProvider } from "../../src/modules/ai/providers/none.provider";
import { as } from "../helpers/api";
import { createDirectConversation, createGroup, SAMPLE_FILES, sendMessage, uploadFile } from "../helpers/fixtures";
import { MemoryStorageProvider } from "../helpers/memoryStorage";
import { ScriptedAIProvider, ScriptedTranscriptionProvider } from "../helpers/scriptedAIProvider";
import { createTestDb } from "../helpers/testDb";
import { signupTestUser, type TestUser } from "../helpers/testUser";

/** A translation in each supported language, in its native script, as a provider would return it. */
const NATIVE: Record<string, { text: string; script: RegExp; scriptName: string }> = {
  ta: { text: "வெள்ளிக்கிழமை சந்திப்போம்", script: /[஀-௿]/, scriptName: "Tamil script" },
  en: { text: "See you on Friday", script: /^[\x20-\x7E]+$/, scriptName: "Latin script" },
  hi: { text: "शुक्रवार को मिलते हैं", script: /[ऀ-ॿ]/, scriptName: "Devanagari script" },
  te: { text: "శుక్రవారం కలుద్దాం", script: /[ఀ-౿]/, scriptName: "Telugu script" },
  ml: { text: "വെള്ളിയാഴ്ച കാണാം", script: /[ഀ-ൿ]/, scriptName: "Malayalam script" },
};

/**
 * Voice message translation: translating the requester's own transcript of
 * a voice message. Real routes, consent checks, media access rules,
 * exclusions and AIGateway; scripted providers only — no real AI service.
 */
describe("Voice message translation", () => {
  let app: Express;
  let db: DatabaseClient;
  let ai: ScriptedAIProvider;
  let stt: ScriptedTranscriptionProvider;
  let alice: TestUser;
  let bob: TestUser;
  let eve: TestUser;
  let conversationId: string;
  let voiceId: string;

  const translate = (user: TestUser, id: string, body: Record<string, unknown>) =>
    as(app, user).post(`/api/v1/ai/voice/${id}/translate`).send(body);
  const translations = (user: TestUser, id: string) => as(app, user).get(`/api/v1/ai/voice/${id}/translations`);
  const transcribe = (user: TestUser, id: string) => as(app, user).post(`/api/v1/ai/voice/${id}/transcribe`).send({});
  const optIn = (user: TestUser) => as(app, user).patch("/api/v1/ai/settings").send({ aiFeaturesEnabled: true, voiceEnabled: true });
  const translated = (text: string, source: string | null = "en") => ({ translated_text: text, detected_source_language: source });

  async function setup(options: { aiProvider?: AIProvider } = {}) {
    db = await createTestDb();
    ai = new ScriptedAIProvider();
    stt = new ScriptedTranscriptionProvider();
    ({ app } = createApp({
      db,
      storage: new MemoryStorageProvider(),
      // Always explicit: never fall back to the provider configured in backend/.env.
      aiProvider: options.aiProvider ?? ai,
      transcriptionProvider: stt,
      aiOptions: { retryBaseDelayMs: 0, maxRetries: 0, timeoutMs: 2000, rateLimitPerMinute: 1000, rateLimitPerDay: 1000 },
    }));
    alice = await signupTestUser(app, { displayName: "Alice", email: "alice@example.com" });
    bob = await signupTestUser(app, { displayName: "Bob", email: "bob@example.com" });
    eve = await signupTestUser(app, { displayName: "Eve", email: "eve@example.com" });
    conversationId = await createDirectConversation(app, alice, bob);
    const upload = await uploadFile(app, bob, conversationId, "plans.ogg", SAMPLE_FILES.ogg);
    voiceId = upload.body.attachment.id as string;
    await sendMessage(app, bob, conversationId, { attachmentId: voiceId });
  }

  async function transcribed(user: TestUser, text = "See you on Friday", language: string | null = "en") {
    await optIn(user);
    stt.respond(text, language);
    expect((await transcribe(user, voiceId)).status).toBe(200);
  }

  describe("with providers configured", () => {
    beforeEach(() => setup());

    it.each(Object.keys(NATIVE))("translates the transcript into %s, in that language's native script", async (code) => {
      await transcribed(alice, "Nos vemos el viernes", "es");
      const native = NATIVE[code]!;
      ai.respond(translated(native.text, "es"));

      const res = await translate(alice, voiceId, { targetLanguage: code });
      expect(res.status).toBe(200);
      expect(res.body.translation).toMatchObject({
        attachmentId: voiceId,
        targetLanguage: code,
        translatedText: native.text,
        detectedSourceLanguage: "es",
        cached: false,
        generatedBy: { provider: "scripted-test", model: "scripted-model" },
      });
      expect(res.body.translation.translatedText).toMatch(native.script);
      // The prompt names the target language and its script, and carries only the transcript.
      const call = ai.calls[0]!;
      expect(call.input).toContain(`(${code})`);
      expect(call.input).toContain(native.scriptName);
      expect(call.input).toContain("Nos vemos el viernes");
      expect(call.system).toContain("Never transliterate");
    });

    it("keeps the original audio and transcript unchanged, and stores one translation per language", async () => {
      await transcribed(alice, "See you on Friday");
      const before = await as(app, alice).get(`/api/v1/media/${voiceId}/content`);
      ai.respond(translated(NATIVE.ta!.text)).respond(translated(NATIVE.hi!.text));
      await translate(alice, voiceId, { targetLanguage: "ta" });
      await translate(alice, voiceId, { targetLanguage: "hi" });

      const after = await as(app, alice).get(`/api/v1/media/${voiceId}/content`);
      expect(after.status).toBe(200);
      expect(Buffer.compare(after.body as Buffer, before.body as Buffer)).toBe(0);
      expect((await as(app, alice).get(`/api/v1/ai/voice/${voiceId}`)).body.result).toMatchObject({
        status: "complete",
        transcript: "See you on Friday",
      });
      const list = await translations(alice, voiceId);
      expect(list.status).toBe(200);
      expect(list.body.translations.map((t: { targetLanguage: string }) => t.targetLanguage).sort()).toEqual(["hi", "ta"]);
      // Nothing internal (the transcript hash) leaks into the response.
      expect(JSON.stringify(list.body)).not.toContain("sourceHash");
    });

    it("serves a repeat request from storage, and regenerates after the voice message is re-transcribed", async () => {
      await transcribed(alice, "See you on Friday");
      ai.respond(translated(NATIVE.ml!.text));
      expect((await translate(alice, voiceId, { targetLanguage: "ml" })).body.translation.cached).toBe(false);

      const again = await translate(alice, voiceId, { targetLanguage: "ml" });
      expect(again.status).toBe(200);
      expect(again.body.translation).toMatchObject({ translatedText: NATIVE.ml!.text, cached: true, generatedBy: null });
      expect(ai.calls).toHaveLength(1);

      // A new transcript makes the stored translation stale: hidden from the list, regenerated on request.
      stt.respond("See you on Saturday", "en");
      await transcribe(alice, voiceId);
      expect((await translations(alice, voiceId)).body.translations).toEqual([]);
      ai.respond(translated("ശനിയാഴ്ച കാണാം"));
      const fresh = await translate(alice, voiceId, { targetLanguage: "ml" });
      expect(fresh.body.translation).toMatchObject({ translatedText: "ശനിയാഴ്ച കാണാം", cached: false });
      expect(ai.calls).toHaveLength(2);
      expect(ai.calls[1]!.input).toContain("See you on Saturday");
    });

    it("concurrent identical requests share one provider call", async () => {
      await transcribed(alice);
      const gate = ai.hold();
      const first = translate(alice, voiceId, { targetLanguage: "te" }).then((r) => r);
      const second = translate(alice, voiceId, { targetLanguage: "te" }).then((r) => r);
      await new Promise((resolve) => setTimeout(resolve, 150));
      gate.release(translated(NATIVE.te!.text));

      const [a, b] = await Promise.all([first, second]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect(a.body.translation.translatedText).toBe(NATIVE.te!.text);
      expect(b.body.translation.translatedText).toBe(NATIVE.te!.text);
      expect(ai.calls).toHaveLength(1);
    });

    it("requires a transcript first", async () => {
      await optIn(alice);
      const res = await translate(alice, voiceId, { targetLanguage: "ta" });
      expect(res.status).toBe(409);
      expect(res.body.error.message).toBe("Transcribe this voice message first");
      expect(ai.calls).toHaveLength(0);
    });

    it("needs AI and Voice Intelligence consent, and sends nothing without it", async () => {
      await transcribed(alice);
      await as(app, alice).patch("/api/v1/ai/settings").send({ voiceEnabled: false });
      const voiceOff = await translate(alice, voiceId, { targetLanguage: "ta" });
      expect(voiceOff.status).toBe(403);
      expect(voiceOff.body.error.code).toBe("ai_disabled");

      await as(app, alice).patch("/api/v1/ai/settings").send({ voiceEnabled: true, aiFeaturesEnabled: false });
      const aiOff = await translate(alice, voiceId, { targetLanguage: "ta" });
      expect(aiOff.status).toBe(403);
      expect(aiOff.body.error.code).toBe("ai_disabled");
      expect(ai.calls).toHaveLength(0);
    });

    it("respects chat exclusions", async () => {
      await transcribed(alice);
      await as(app, alice).put(`/api/v1/ai/exclusions/${conversationId}`);
      const res = await translate(alice, voiceId, { targetLanguage: "hi" });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("ai_conversation_excluded");
      expect(ai.calls).toHaveLength(0);
    });

    it("only accepts the five supported target languages", async () => {
      await transcribed(alice);
      for (const body of [{ targetLanguage: "fr" }, { targetLanguage: "xx" }, { targetLanguage: "Tamil" }, {}, { targetLanguage: "ta", extra: 1 }]) {
        expect((await translate(alice, voiceId, body)).status).toBe(400);
      }
      expect((await as(app, alice).post("/api/v1/ai/voice/not-a-uuid/translate").send({ targetLanguage: "ta" })).status).toBe(400);
      expect(ai.calls).toHaveLength(0);
    });

    it("refuses attachments the user can't read, and keeps translations private to the requester", async () => {
      await transcribed(alice);
      ai.respond(translated(NATIVE.ta!.text));
      await translate(alice, voiceId, { targetLanguage: "ta" });

      // Eve isn't in the chat.
      await optIn(eve);
      expect((await translate(eve, voiceId, { targetLanguage: "ta" })).status).toBe(403);
      expect((await translations(eve, voiceId)).status).toBe(403);
      // Bob can read the voice message, but Alice's transcript and translation are hers alone.
      await optIn(bob);
      expect((await translations(bob, voiceId)).body.translations).toEqual([]);
      expect((await translate(bob, voiceId, { targetLanguage: "ta" })).status).toBe(409);
      // Unknown attachment.
      expect((await translate(alice, "00000000-0000-4000-8000-000000000000", { targetLanguage: "ta" })).status).toBe(404);
      expect(ai.calls).toHaveLength(1);
    });

    it("someone who left the group can no longer translate or read translations", async () => {
      await optIn(alice);
      const { groupId, conversationId: group } = await createGroup(app, bob, [alice]);
      const upload = await uploadFile(app, bob, group, "note.ogg", SAMPLE_FILES.ogg);
      const id = upload.body.attachment.id as string;
      await sendMessage(app, bob, group, { attachmentId: id });
      stt.respond("Group note");
      await transcribe(alice, id);
      ai.respond(translated(NATIVE.hi!.text));
      expect((await translate(alice, id, { targetLanguage: "hi" })).status).toBe(200);

      await as(app, alice).post(`/api/v1/groups/${groupId}/leave`);
      expect((await translate(alice, id, { targetLanguage: "hi" })).status).toBe(403);
      expect((await translations(alice, id)).status).toBe(403);
    });

    it("refuses attachments that aren't audio", async () => {
      await optIn(alice);
      const image = await uploadFile(app, bob, conversationId, "pic.png", SAMPLE_FILES.png);
      await sendMessage(app, bob, conversationId, { attachmentId: image.body.attachment.id });
      expect((await translate(alice, image.body.attachment.id, { targetLanguage: "ta" })).status).toBe(400);
    });

    it("reports provider failures and malformed output cleanly, keeping the transcript", async () => {
      await transcribed(alice);
      ai.fail(new ProviderCallError("down", "overloaded", true));
      const failed = await translate(alice, voiceId, { targetLanguage: "ta" });
      expect(failed.status).toBe(502);
      expect(failed.body.error.code).toBe("ai_provider_error");

      ai.respond({ nope: true });
      expect((await translate(alice, voiceId, { targetLanguage: "ta" })).status).toBe(502);
      expect((await translations(alice, voiceId)).body.translations).toEqual([]);
      expect((await as(app, alice).get(`/api/v1/ai/voice/${voiceId}`)).body.result.transcript).toBe("See you on Friday");
    });
  });

  it("works end to end with Gemini for both transcription and translation (SDK faked, nothing leaves the process)", async () => {
    db = await createTestDb();
    const generateContent = vi.fn<GeminiModelsClient["generateContent"]>();
    const reply = (value: unknown) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] }, finishReason: "STOP" }] });
    ({ app } = createApp({
      db,
      storage: new MemoryStorageProvider(),
      aiProvider: new GeminiProvider({ apiKey: "test-gemini-key-not-real", model: "gemini-test-model" }, { generateContent }),
      transcriptionProvider: new GeminiTranscriptionProvider({ apiKey: "test-gemini-key-not-real", model: "gemini-test-model" }, { generateContent }),
      aiOptions: { retryBaseDelayMs: 0, maxRetries: 0, rateLimitPerMinute: 1000, rateLimitPerDay: 1000 },
    }));
    alice = await signupTestUser(app, { displayName: "Alice", email: "alice@example.com" });
    bob = await signupTestUser(app, { displayName: "Bob", email: "bob@example.com" });
    conversationId = await createDirectConversation(app, alice, bob);
    const upload = await uploadFile(app, bob, conversationId, "note.ogg", SAMPLE_FILES.ogg);
    voiceId = upload.body.attachment.id as string;
    await sendMessage(app, bob, conversationId, { attachmentId: voiceId });
    await optIn(alice);

    const settings = await as(app, alice).get("/api/v1/ai/settings");
    expect(settings.body.transcription).toEqual({ name: "gemini", configured: true });
    expect(settings.body.voiceTranslationLanguages).toEqual([
      { code: "ta", name: "Tamil" },
      { code: "en", name: "English" },
      { code: "hi", name: "Hindi" },
      { code: "te", name: "Telugu" },
      { code: "ml", name: "Malayalam" },
    ]);
    expect(JSON.stringify(settings.body)).not.toContain("test-gemini-key-not-real");

    generateContent.mockResolvedValueOnce(reply({ text: "நாளை சந்திப்போம்", language: "ta" }) as never);
    const transcript = await transcribe(alice, voiceId);
    expect(transcript.body.result).toMatchObject({ status: "complete", transcript: "நாளை சந்திப்போம்", detectedLanguage: "ta" });
    const audioPart = (generateContent.mock.calls[0]![0].contents as Array<{ parts: Array<{ inlineData?: { mimeType: string } }> }>)[0]!
      .parts[1]!;
    expect(audioPart.inlineData!.mimeType).toBe("audio/ogg");

    generateContent.mockResolvedValueOnce(reply({ translated_text: "See you tomorrow", detected_source_language: "ta" }) as never);
    const res = await translate(alice, voiceId, { targetLanguage: "en" });
    expect(res.body.translation).toMatchObject({ translatedText: "See you tomorrow", detectedSourceLanguage: "ta", generatedBy: { provider: "gemini" } });
    // Translation sends only the transcript text, never the audio.
    expect(JSON.stringify(generateContent.mock.calls[1]![0].contents)).not.toContain("inlineData");
    expect(generateContent).toHaveBeenCalledTimes(2);

    // Audio over Gemini's inline limit is refused before anything is sent.
    await db.query("UPDATE attachments SET size_bytes = $2 WHERE id = $1", [voiceId, GEMINI_INLINE_AUDIO_MAX_BYTES + 1]);
    expect((await transcribe(alice, voiceId)).status).toBe(413);
    expect(generateContent).toHaveBeenCalledTimes(2);
  });

  it("reports 'not configured' when no text provider is set up, and never fakes a translation", async () => {
    await setup({ aiProvider: new NoneAIProvider() });
    await transcribed(alice);
    const res = await translate(alice, voiceId, { targetLanguage: "ta" });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("ai_not_configured");
    expect((await translations(alice, voiceId)).body.translations).toEqual([]);
  });
});
