import type { Express } from "express";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import type { DatabaseClient } from "../../src/db/pool";
import { INTERRUPTED, NO_SPEECH } from "../../src/modules/ai/features/voice.service";
import { ProviderCallError } from "../../src/modules/ai/interfaces/ai-provider.interface";
import { as } from "../helpers/api";
import { createDirectConversation, createGroup, SAMPLE_FILES, sendMessage, uploadFile } from "../helpers/fixtures";
import { MemoryStorageProvider } from "../helpers/memoryStorage";
import { ScriptedAIProvider, ScriptedTranscriptionProvider } from "../helpers/scriptedAIProvider";
import { createTestDb } from "../helpers/testDb";
import { signupTestUser, type TestUser } from "../helpers/testUser";

/**
 * Voice-note transcription, beyond the happy path covered in
 * ai-features.test.ts: opt-in, provider availability, authorization,
 * duplicate/concurrent requests, retries, empty results, formats, size,
 * timeouts and rate limits. All against a scripted provider — no real
 * speech-to-text service is called.
 */
describe("Voice note transcription", () => {
  let app: Express;
  let db: DatabaseClient;
  let stt: ScriptedTranscriptionProvider;
  let alice: TestUser;
  let bob: TestUser;
  let eve: TestUser;
  let conversationId: string;
  let voiceId: string;

  const transcribe = (user: TestUser, id: string, body: Record<string, unknown> = {}) => as(app, user).post(`/api/v1/ai/voice/${id}/transcribe`).send(body);
  const result = async (user: TestUser, id: string) => (await as(app, user).get(`/api/v1/ai/voice/${id}`)).body.result;
  const optIn = (user: TestUser) => as(app, user).patch("/api/v1/ai/settings").send({ aiFeaturesEnabled: true, voiceEnabled: true });

  async function setup(options: { transcription?: ScriptedTranscriptionProvider | null; maxAudioBytes?: number; timeoutMs?: number; perMinute?: number } = {}) {
    db = await createTestDb();
    stt = new ScriptedTranscriptionProvider();
    ({ app } = createApp({
      db,
      storage: new MemoryStorageProvider(),
      aiProvider: new ScriptedAIProvider(),
      // null: no transcription provider configured (TRANSCRIPTION_PROVIDER unset → "none").
      transcriptionProvider: options.transcription === null ? undefined : (options.transcription ?? stt),
      aiOptions: {
        retryBaseDelayMs: 0,
        maxRetries: 1,
        timeoutMs: options.timeoutMs ?? 2000,
        rateLimitPerMinute: options.perMinute ?? 1000,
        rateLimitPerDay: 1000,
        ...(options.maxAudioBytes ? { maxAudioBytes: options.maxAudioBytes } : {}),
      },
    }));
    alice = await signupTestUser(app, { displayName: "Alice", email: "alice@example.com" });
    bob = await signupTestUser(app, { displayName: "Bob", email: "bob@example.com" });
    eve = await signupTestUser(app, { displayName: "Eve", email: "eve@example.com" });
    conversationId = await createDirectConversation(app, alice, bob);
    const upload = await uploadFile(app, bob, conversationId, "Holiday plans (private).ogg", SAMPLE_FILES.ogg);
    voiceId = upload.body.attachment.id as string;
    await sendMessage(app, bob, conversationId, { attachmentId: voiceId });
  }

  describe("with a transcription provider", () => {
    beforeEach(() => setup());

    it("is opt-in: nothing is sent to the provider until the user turns Voice Intelligence on", async () => {
      const res = await transcribe(alice, voiceId);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("ai_disabled");
      expect(stt.calls).toHaveLength(0);
    });

    it("transcribes on request with an optional language, sending a neutral file name — and keeps the result private to the requester", async () => {
      await optIn(alice);
      stt.respond("Hola, nos vemos el viernes", "es");
      const res = await transcribe(alice, voiceId, { languageHint: "es" });
      expect(res.status).toBe(200);
      expect(res.body.result).toMatchObject({ status: "complete", transcript: "Hola, nos vemos el viernes", detectedLanguage: "es" });
      expect(stt.calls[0]).toMatchObject({ languageHint: "es", mimeType: "audio/ogg", filename: "voice-message.ogg" });

      // Bob (the sender) hasn't transcribed it: his view is empty. Eve isn't in the chat at all.
      expect(await result(bob, voiceId)).toBeNull();
      expect((await as(app, eve).get(`/api/v1/ai/voice/${voiceId}`)).status).toBe(403);
      await optIn(eve);
      expect((await transcribe(eve, voiceId)).status).toBe(403);
      expect(stt.calls).toHaveLength(1);
    });

    it("someone who left the group can no longer request or read a transcript", async () => {
      await optIn(alice);
      await optIn(bob);
      const { groupId, conversationId: group } = await createGroup(app, bob, [alice]);
      const upload = await uploadFile(app, bob, group, "note.ogg", SAMPLE_FILES.ogg);
      await sendMessage(app, bob, group, { attachmentId: upload.body.attachment.id });
      stt.respond("Group note");
      expect((await transcribe(alice, upload.body.attachment.id)).status).toBe(200);

      await as(app, alice).post(`/api/v1/groups/${groupId}/leave`);
      expect((await as(app, alice).get(`/api/v1/ai/voice/${upload.body.attachment.id}`)).status).toBe(403);
      expect((await transcribe(alice, upload.body.attachment.id)).status).toBe(403);
    });

    it("concurrent requests for the same voice message share one provider call", async () => {
      await optIn(alice);
      const gate = stt.hold();
      // .then() sends the request now (supertest is lazy until awaited).
      const first = transcribe(alice, voiceId).then((r) => r);
      const second = transcribe(alice, voiceId).then((r) => r);
      // Let both requests reach the service before the provider answers.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(await result(alice, voiceId)).toMatchObject({ status: "transcribing" });
      gate.release({ text: "Only once", detectedLanguage: "en" });

      const [a, b] = await Promise.all([first, second]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect(a.body.result.transcript).toBe("Only once");
      expect(b.body.result.transcript).toBe("Only once");
      expect(stt.calls).toHaveLength(1);
    });

    it("different users transcribe independently (each opted in, each with their own result)", async () => {
      await optIn(alice);
      await optIn(bob);
      stt.respond("Alice's copy").respond("Bob's copy");
      await transcribe(alice, voiceId);
      await transcribe(bob, voiceId);
      expect((await result(alice, voiceId)).transcript).toBe("Alice's copy");
      expect((await result(bob, voiceId)).transcript).toBe("Bob's copy");
      expect(stt.calls).toHaveLength(2);
    });

    it("a failure is recorded, then retrying succeeds", async () => {
      await optIn(alice);
      stt.fail(new ProviderCallError("bad audio", "bad_request", false));
      const failed = await transcribe(alice, voiceId);
      expect(failed.status).toBe(502);
      expect(failed.body.error.code).toBe("ai_provider_error");
      expect(await result(alice, voiceId)).toMatchObject({ status: "failed", transcript: null });

      stt.respond("Second time lucky");
      const retried = await transcribe(alice, voiceId);
      expect(retried.status).toBe(200);
      expect(retried.body.result).toMatchObject({ status: "complete", transcript: "Second time lucky", errorMessage: null });
    });

    it("no speech is an empty result, not an error", async () => {
      await optIn(alice);
      stt.respond("   ");
      const res = await transcribe(alice, voiceId);
      expect(res.status).toBe(200);
      expect(res.body.result).toMatchObject({ status: "failed", transcript: null, errorMessage: NO_SPEECH });
    });

    it("refuses formats the provider can't take and anything that isn't audio, before sending audio anywhere", async () => {
      await optIn(alice);
      await db.query("UPDATE attachments SET mime_type = 'audio/aac' WHERE id = $1", [voiceId]);
      const res = await transcribe(alice, voiceId);
      expect(res.status).toBe(415);
      expect(res.body.error.message).toBe("This audio format can't be transcribed");

      const image = await uploadFile(app, bob, conversationId, "pic.png", SAMPLE_FILES.png);
      await sendMessage(app, bob, conversationId, { attachmentId: image.body.attachment.id });
      expect((await transcribe(alice, image.body.attachment.id)).status).toBe(400);
      expect(stt.calls).toHaveLength(0);
    });

    it("retries a provider rate limit once, then reports a provider error", async () => {
      await optIn(alice);
      stt.fail(new ProviderCallError("slow down", "rate_limited", true)).fail(new ProviderCallError("slow down", "rate_limited", true));
      const res = await transcribe(alice, voiceId);
      expect(res.status).toBe(502);
      expect(stt.calls).toHaveLength(2);
    });

    it.each([
      ["Chrome/Edge", "voice-message-20261112T102030Z.weba", SAMPLE_FILES.webmAudio, "audio/webm;codecs=opus", "audio/webm", "voice-message.webm"],
      ["Firefox", "voice-message-20261112T102030Z.ogg", SAMPLE_FILES.ogg, "audio/ogg;codecs=opus", "audio/ogg", "voice-message.ogg"],
      ["Safari", "voice-message-20261112T102030Z.m4a", SAMPLE_FILES.m4aRecording, "audio/mp4", "audio/mp4", "voice-message.m4a"],
    ])("an in-chat %s recording is sent as an audio message and can be transcribed", async (_browser, name, data, declared, stored, sentName) => {
      await optIn(alice);
      const upload = await uploadFile(app, bob, conversationId, name, data, declared);
      expect(upload.status).toBe(201);
      expect(upload.body.attachment).toMatchObject({ kind: "audio", mimeType: stored });
      const sent = await sendMessage(app, bob, conversationId, { attachmentId: upload.body.attachment.id });
      expect(sent.body.message.contentType).toBe("audio");

      stt.respond("Recorded in the browser");
      const res = await transcribe(alice, upload.body.attachment.id);
      expect(res.status).toBe(200);
      expect(stt.calls[0]).toMatchObject({ mimeType: stored, filename: sentName });
    });

    it("rejects malformed language codes and IDs", async () => {
      await optIn(alice);
      expect((await transcribe(alice, voiceId, { languageHint: "Spanish" })).status).toBe(400);
      expect((await transcribe(alice, voiceId, { languageHint: "es", extra: true })).status).toBe(400);
      expect((await as(app, alice).post("/api/v1/ai/voice/not-a-uuid/transcribe").send({})).status).toBe(400);
      expect(stt.calls).toHaveLength(0);
    });

    it("a transcription interrupted by a server restart reads as failed (so it can be retried), not 'working' forever", async () => {
      await optIn(alice);
      stt.respond("done");
      await transcribe(alice, voiceId);
      // Simulate a row left behind by a request that was running when the server stopped.
      await db.query("UPDATE ai_voice_results SET status = 'transcribing' WHERE user_id = $1 AND attachment_id = $2", [alice.userId, voiceId]);
      expect(await result(alice, voiceId)).toMatchObject({ status: "failed", errorMessage: INTERRUPTED });
    });
  });

  it("reports 'not configured' when no transcription provider is set up, and sends nothing", async () => {
    await setup({ transcription: null });
    await optIn(alice);
    const res = await transcribe(alice, voiceId);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("ai_not_configured");
    expect((await as(app, alice).get("/api/v1/ai/settings")).body.transcription.configured).toBe(false);
    expect(stt.calls).toHaveLength(0);
  });

  it("refuses voice messages over the configured size limit", async () => {
    await setup({ maxAudioBytes: 8 });
    await optIn(alice);
    const res = await transcribe(alice, voiceId);
    expect(res.status).toBe(413);
    expect(stt.calls).toHaveLength(0);
  });

  it("gives up with a timeout error when the provider doesn't answer", async () => {
    await setup({ timeoutMs: 100 });
    await optIn(alice);
    stt.hang().hang();
    const res = await transcribe(alice, voiceId);
    expect(res.status).toBe(504);
    expect(res.body.error.code).toBe("ai_timeout");
    expect(await result(alice, voiceId)).toMatchObject({ status: "failed" });
  });

  it("applies the per-user AI rate limit", async () => {
    await setup({ perMinute: 1 });
    await optIn(alice);
    stt.respond("first");
    expect((await transcribe(alice, voiceId)).status).toBe(200);
    const limited = await transcribe(alice, voiceId);
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("ai_rate_limited");
    expect(stt.calls).toHaveLength(1);
  });

  it("never sends the user's own file name to the provider", async () => {
    await setup();
    await optIn(alice);
    stt.respond("ok");
    await transcribe(alice, voiceId);
    expect(JSON.stringify(stt.calls[0]!.filename)).not.toContain("Holiday");
  });
});
