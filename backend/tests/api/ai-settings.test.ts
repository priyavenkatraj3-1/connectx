import type { Express } from "express";
import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { NoneAIProvider, NoneTranscriptionProvider } from "../../src/modules/ai/providers/none.provider";
import { createDirectConversation, createGroup, sendMessage } from "../helpers/fixtures";
import { createTestDb } from "../helpers/testDb";
import { signupTestUser, type TestUser } from "../helpers/testUser";

function auth(user: TestUser) {
  return { Authorization: `Bearer ${user.accessToken}` };
}

/**
 * AI settings, consent, memory ownership and the "no provider configured"
 * behavior. The app here runs with the real unconfigured provider — no AI
 * output exists anywhere in this file.
 */
describe("AI settings, consent and unavailable provider", () => {
  let app: Express;
  let alice: TestUser;
  let bob: TestUser;
  let eve: TestUser;
  let directId: string;
  let messageId: string;

  beforeAll(async () => {
    const db = await createTestDb();
    ({ app } = createApp({ db, aiProvider: new NoneAIProvider(), transcriptionProvider: new NoneTranscriptionProvider() }));
    alice = await signupTestUser(app, { displayName: "Alice" });
    bob = await signupTestUser(app, { displayName: "Bob" });
    eve = await signupTestUser(app, { displayName: "Eve" });
    directId = await createDirectConversation(app, alice, bob);
    messageId = (await sendMessage(app, bob, directId, { body: "Hola, ¿cómo estás?" })).body.message.id as string;
  });

  it("requires authentication on every AI route", async () => {
    for (const [method, path] of [
      ["get", "/api/v1/ai/settings"],
      ["post", "/api/v1/ai/ask"],
      ["get", "/api/v1/ai/memories"],
      ["post", `/api/v1/ai/messages/${messageId}/translate`],
    ] as const) {
      expect((await request(app)[method](path)).status).toBe(401);
    }
  });

  it("defaults every AI feature to off and reports the provider as not configured", async () => {
    const res = await request(app).get("/api/v1/ai/settings").set(auth(alice));
    expect(res.status).toBe(200);
    expect(res.body.settings).toMatchObject({
      aiFeaturesEnabled: false,
      aiMemoryEnabled: false,
      spamShieldEnabled: false,
      voiceEnabled: false,
      preferredLanguage: "en",
      consentedAt: null,
    });
    expect(res.body.provider).toEqual({ name: "none", configured: false, model: null });
    expect(res.body.transcription).toEqual({ name: "none", configured: false });
    expect(res.body.dataSharing.length).toBeGreaterThan(0);
    expect(JSON.stringify(res.body)).not.toMatch(/api_?key/i);
  });

  it("updates settings, records consent time, and validates input", async () => {
    const res = await request(app)
      .patch("/api/v1/ai/settings")
      .set(auth(alice))
      .send({ aiFeaturesEnabled: true, preferredLanguage: "es" });
    expect(res.status).toBe(200);
    expect(res.body.settings.aiFeaturesEnabled).toBe(true);
    expect(res.body.settings.preferredLanguage).toBe("es");
    expect(res.body.settings.consentedAt).not.toBeNull();

    expect((await request(app).patch("/api/v1/ai/settings").set(auth(alice)).send({ preferredLanguage: "klingon" })).status).toBe(400);
    expect((await request(app).patch("/api/v1/ai/settings").set(auth(alice)).send({ bogus: true })).status).toBe(400);
    expect((await request(app).patch("/api/v1/ai/settings").set(auth(alice)).send({})).status).toBe(400);

    // Settings are per user.
    expect((await request(app).get("/api/v1/ai/settings").set(auth(bob))).body.settings.aiFeaturesEnabled).toBe(false);
  });

  it("rejects AI use with 403 ai_disabled until the user opts in", async () => {
    const res = await request(app).post("/api/v1/ai/ask").set(auth(bob)).send({ question: "What's up?", conversationIds: [directId] });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ai_disabled");
  });

  it("returns 503 ai_not_configured (never fake output) once opted in but no provider exists", async () => {
    // Alice opted in above.
    const ask = await request(app).post("/api/v1/ai/ask").set(auth(alice)).send({ question: "How is Bob?", conversationIds: [directId] });
    expect(ask.status).toBe(503);
    expect(ask.body.error.code).toBe("ai_not_configured");
    expect(ask.body.answer).toBeUndefined();

    const translate = await request(app).post(`/api/v1/ai/messages/${messageId}/translate`).set(auth(alice)).send({ targetLanguage: "en" });
    expect(translate.status).toBe(503);

    const { conversationId: groupId } = await createGroup(app, alice, [bob]);
    await sendMessage(app, bob, groupId, { body: "Let's pick a date" });
    const summary = await request(app).post(`/api/v1/ai/conversations/${groupId}/decision-summary`).set(auth(alice)).send({});
    expect(summary.status).toBe(503);

    const extract = await request(app).post(`/api/v1/ai/conversations/${directId}/actions/extract`).set(auth(alice)).send({});
    expect(extract.status).toBe(503);
  });

  it("validates Ask Your Chats input", async () => {
    const tooLong = "x".repeat(501);
    expect((await request(app).post("/api/v1/ai/ask").set(auth(alice)).send({ question: tooLong, conversationIds: [directId] })).status).toBe(400);
    expect((await request(app).post("/api/v1/ai/ask").set(auth(alice)).send({ question: "hi", conversationIds: [] })).status).toBe(400);
    expect((await request(app).post("/api/v1/ai/ask").set(auth(alice)).send({ question: "hi", conversationIds: ["nope"] })).status).toBe(400);
  });

  describe("AI memory", () => {
    it("refuses to store memory until memory is explicitly enabled", async () => {
      const res = await request(app).post("/api/v1/ai/memories").set(auth(alice)).send({ type: "preference", content: "I prefer short answers" });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("ai_disabled");
      expect((await request(app).get("/api/v1/ai/memories").set(auth(alice))).body).toEqual({ enabled: false, items: [] });
    });

    it("creates, lists, deletes and clears memory — scoped to its owner", async () => {
      await request(app).patch("/api/v1/ai/settings").set(auth(alice)).send({ aiMemoryEnabled: true });
      await request(app).patch("/api/v1/ai/settings").set(auth(eve)).send({ aiMemoryEnabled: true });

      const created = await request(app)
        .post("/api/v1/ai/memories")
        .set(auth(alice))
        .send({ type: "preference", content: "  I prefer short answers  " });
      expect(created.status).toBe(201);
      expect(created.body.memory).toMatchObject({ type: "preference", content: "I prefer short answers", sourceMessageId: null });
      const memoryId = created.body.memory.id as string;

      const fromMessage = await request(app)
        .post("/api/v1/ai/memories")
        .set(auth(alice))
        .send({ type: "fact", content: "Bob speaks Spanish", sourceMessageId: messageId });
      expect(fromMessage.status).toBe(201);
      expect(fromMessage.body.memory.sourceConversationId).toBe(directId);

      // Eve can't reference a message she can't see, can't see Alice's memory, and can't delete it.
      expect(
        (await request(app).post("/api/v1/ai/memories").set(auth(eve)).send({ type: "fact", content: "x", sourceMessageId: messageId })).status
      ).toBe(404);
      expect((await request(app).get("/api/v1/ai/memories").set(auth(eve))).body.items).toEqual([]);
      expect((await request(app).delete(`/api/v1/ai/memories/${memoryId}`).set(auth(eve))).status).toBe(404);

      const list = await request(app).get("/api/v1/ai/memories").set(auth(alice));
      expect(list.body.enabled).toBe(true);
      expect(list.body.items).toHaveLength(2);

      expect((await request(app).delete(`/api/v1/ai/memories/${memoryId}`).set(auth(alice))).status).toBe(204);
      expect((await request(app).get("/api/v1/ai/memories").set(auth(alice))).body.items).toHaveLength(1);

      // Disabling memory doesn't hide or block deleting what's stored.
      await request(app).patch("/api/v1/ai/settings").set(auth(alice)).send({ aiMemoryEnabled: false });
      const cleared = await request(app).delete("/api/v1/ai/memories").set(auth(alice));
      expect(cleared.body).toEqual({ deleted: 1 });
      expect((await request(app).get("/api/v1/ai/memories").set(auth(alice))).body.items).toEqual([]);
    });

    it("validates memory input", async () => {
      await request(app).patch("/api/v1/ai/settings").set(auth(alice)).send({ aiMemoryEnabled: true });
      expect((await request(app).post("/api/v1/ai/memories").set(auth(alice)).send({ type: "secret", content: "x" })).status).toBe(400);
      expect((await request(app).post("/api/v1/ai/memories").set(auth(alice)).send({ type: "fact", content: "   " })).status).toBe(400);
      expect(
        (await request(app).post("/api/v1/ai/memories").set(auth(alice)).send({ type: "fact", content: "y".repeat(501) })).status
      ).toBe(400);
    });
  });

  describe("conversation exclusions", () => {
    it("lets a member exclude a chat, blocks non-members, and can be undone", async () => {
      expect((await request(app).put(`/api/v1/ai/exclusions/${directId}`).set(auth(eve))).status).toBe(403);
      const added = await request(app).put(`/api/v1/ai/exclusions/${directId}`).set(auth(bob));
      expect(added.body.conversationIds).toEqual([directId]);
      const removed = await request(app).delete(`/api/v1/ai/exclusions/${directId}`).set(auth(bob));
      expect(removed.body.conversationIds).toEqual([]);
    });
  });

  describe("Scam/Spam Shield (local heuristics, no provider)", () => {
    it("works without any AI provider once enabled, and only for members", async () => {
      const scam = await sendMessage(app, bob, directId, {
        body: "URGENT: your account is suspended. Send me the verification code you just received: http://paypal-secure-login.xyz/verify",
      });
      const normal = await sendMessage(app, bob, directId, { body: "See you at lunch tomorrow" });
      const ids = [scam.body.message.id as string, normal.body.message.id as string];

      const disabled = await request(app).post(`/api/v1/ai/conversations/${directId}/safety-scan`).set(auth(alice)).send({ messageIds: ids });
      expect(disabled.status).toBe(403);

      await request(app).patch("/api/v1/ai/settings").set(auth(alice)).send({ spamShieldEnabled: true });
      const res = await request(app).post(`/api/v1/ai/conversations/${directId}/safety-scan`).set(auth(alice)).send({ messageIds: ids });
      expect(res.status).toBe(200);
      expect(res.body.findings).toHaveLength(1);
      expect(res.body.findings[0]).toMatchObject({ messageId: ids[0], riskLevel: "high_risk" });
      expect(res.body.findings[0].links[0].url).toContain("paypal-secure-login.xyz");

      await request(app).patch("/api/v1/ai/settings").set(auth(eve)).send({ spamShieldEnabled: true });
      expect(
        (await request(app).post(`/api/v1/ai/conversations/${directId}/safety-scan`).set(auth(eve)).send({ messageIds: ids })).status
      ).toBe(403);

      // Dismissed warnings don't come back; the AI check still needs a provider.
      expect(
        (await request(app).post(`/api/v1/ai/messages/${ids[0]}/safety-feedback`).set(auth(alice)).send({ action: "dismissed" })).status
      ).toBe(204);
      const again = await request(app).post(`/api/v1/ai/conversations/${directId}/safety-scan`).set(auth(alice)).send({ messageIds: ids });
      expect(again.body.findings).toEqual([]);
      expect((await request(app).post(`/api/v1/ai/messages/${ids[0]}/scam-check`).set(auth(alice))).status).toBe(503);
      expect(
        (await request(app).post(`/api/v1/ai/messages/${ids[0]}/safety-feedback`).set(auth(eve)).send({ action: "reported" })).status
      ).toBe(404);
    });
  });
});
