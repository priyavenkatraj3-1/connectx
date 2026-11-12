import type { Express } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app";
import type { GeminiModelsClient } from "../../src/modules/ai/providers/gemini.provider";
import { GeminiProvider } from "../../src/modules/ai/providers/gemini.provider";
import { createDirectConversation, sendMessage } from "../helpers/fixtures";
import { MemoryStorageProvider } from "../helpers/memoryStorage";
import { createTestDb } from "../helpers/testDb";
import { signupTestUser, type TestUser } from "../helpers/testUser";

function auth(user: TestUser) {
  return { Authorization: `Bearer ${user.accessToken}` };
}

function geminiText(text: string) {
  return { candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }], modelVersion: "gemini-test-model-001" };
}

/**
 * The real routes, consent checks, exclusions and AIGateway with the
 * Gemini provider in place — only the SDK's `generateContent` is faked, so
 * no request ever leaves the process. Shows that switching providers keeps
 * every ConnectX safeguard in front of (and behind) the model call.
 */
describe("AI features with the Gemini provider (mocked SDK)", () => {
  let app: Express;
  let alice: TestUser;
  let bob: TestUser;
  let directId: string;
  let messageId: string;
  const generateContent = vi.fn<GeminiModelsClient["generateContent"]>();

  beforeAll(async () => {
    const db = await createTestDb();
    const provider = new GeminiProvider({ apiKey: "test-gemini-key-not-real", model: "gemini-test-model" }, { generateContent });
    ({ app } = createApp({
      db,
      storage: new MemoryStorageProvider(),
      aiProvider: provider,
      aiOptions: { retryBaseDelayMs: 0, maxRetries: 1, timeoutMs: 500, rateLimitPerMinute: 1000, rateLimitPerDay: 1000 },
    }));
    alice = await signupTestUser(app, { displayName: "Alice" });
    bob = await signupTestUser(app, { displayName: "Bob" });
    directId = await createDirectConversation(app, alice, bob);
    const sent = await sendMessage(app, bob, directId, { body: "Hola amigos" });
    messageId = sent.body.message.id as string;
  });

  beforeEach(() => generateContent.mockReset());

  const translate = () => request(app).post(`/api/v1/ai/messages/${messageId}/translate`).set(auth(alice)).send({ targetLanguage: "ta" });

  it("reports Gemini as the configured provider, without exposing the key", async () => {
    const res = await request(app).get("/api/v1/ai/settings").set(auth(alice));
    expect(res.status).toBe(200);
    expect(res.body.provider).toMatchObject({ name: "gemini", configured: true, model: "gemini-test-model" });
    expect(JSON.stringify(res.body)).not.toContain("test-gemini-key-not-real");
  });

  it("enforces consent before any Gemini call", async () => {
    const res = await translate();
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ai_disabled");
    expect(generateContent).not.toHaveBeenCalled();
  });

  it("translates through Gemini once the user opts in, with validated structured output", async () => {
    await request(app).patch("/api/v1/ai/settings").set(auth(alice)).send({ aiFeaturesEnabled: true });
    generateContent.mockResolvedValue(geminiText('{"translated_text":"வணக்கம் நண்பர்களே","detected_source_language":"es"}'));

    const res = await translate();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ translatedText: "வணக்கம் நண்பர்களே", detectedSourceLanguage: "es", cached: false });
    expect(res.body.generatedBy).toMatchObject({ provider: "gemini" });

    // Untrusted chat content goes in the user turn; ConnectX's rules stay in the system instruction.
    const params = generateContent.mock.calls[0][0];
    expect(params.config?.systemInstruction).toContain("translation engine");
    expect(JSON.stringify(params.contents)).toContain("Hola amigos");
    expect(params.config?.responseMimeType).toBe("application/json");
  });

  it("rejects malformed Gemini output with 502 instead of passing it on", async () => {
    const other = await sendMessage(app, bob, directId, { body: "Adiós" });
    generateContent.mockResolvedValue(geminiText("not json at all"));
    const res = await request(app).post(`/api/v1/ai/messages/${other.body.message.id}/translate`).set(auth(alice)).send({ targetLanguage: "hi" });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("ai_invalid_output");
  });

  it("maps a Gemini safety block to 422 ai_refused", async () => {
    const other = await sendMessage(app, bob, directId, { body: "Hasta luego" });
    generateContent.mockResolvedValue({ promptFeedback: { blockReason: "SAFETY" } } as never);
    const res = await request(app).post(`/api/v1/ai/messages/${other.body.message.id}/translate`).set(auth(alice)).send({ targetLanguage: "te" });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("ai_refused");
  });

  it("respects chat exclusions: an excluded chat is never sent to Gemini", async () => {
    const other = await sendMessage(app, bob, directId, { body: "Buenas noches" });
    await request(app).put(`/api/v1/ai/exclusions/${directId}`).set(auth(alice));
    const res = await request(app).post(`/api/v1/ai/messages/${other.body.message.id}/translate`).set(auth(alice)).send({ targetLanguage: "ml" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("ai_conversation_excluded");
    expect(generateContent).not.toHaveBeenCalled();
    await request(app).delete(`/api/v1/ai/exclusions/${directId}`).set(auth(alice));
  });
});
