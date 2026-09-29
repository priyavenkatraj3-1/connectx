import type { Express } from "express";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { generateId } from "../../src/utils/id";
import { as } from "../helpers/api";
import { FakeRealtimeGateway } from "../helpers/fakeRealtimeGateway";
import { createDirectConversation, sendMessage } from "../helpers/fixtures";
import { createTestDb } from "../helpers/testDb";
import { signupTestUser, type TestUser } from "../helpers/testUser";

describe("Offline send idempotency and multi-device sync (Phase 6)", () => {
  let app: Express;
  let gateway: FakeRealtimeGateway;
  let alice: TestUser;
  let bob: TestUser;
  let carol: TestUser;
  let directId: string;

  beforeEach(async () => {
    gateway = new FakeRealtimeGateway();
    ({ app } = createApp({ db: await createTestDb(), realtimeGateway: gateway }));
    alice = await signupTestUser(app, { displayName: "Alice" });
    bob = await signupTestUser(app, { displayName: "Bob" });
    carol = await signupTestUser(app, { displayName: "Carol" });
    directId = await createDirectConversation(app, alice, bob);
  });

  it("a retried send with the same clientMessageId returns the original message instead of a duplicate", async () => {
    const clientMessageId = generateId();
    const first = await sendMessage(app, alice, directId, { body: "sent while flaky", clientMessageId });
    const retry = await sendMessage(app, alice, directId, { body: "sent while flaky", clientMessageId });
    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.body.message.id).toBe(first.body.message.id);
    expect(first.body.message.clientMessageId).toBe(clientMessageId);

    const messages = (await as(app, bob).get(`/api/v1/messages/${directId}`)).body.items;
    expect(messages).toHaveLength(1);
    // Recipients are only notified once.
    expect(gateway.eventsFor(bob.userId).filter((e) => e.type === "message:new")).toHaveLength(1);
  });

  it("concurrent retries still produce one message", async () => {
    const clientMessageId = generateId();
    const results = await Promise.all([1, 2, 3].map(() => sendMessage(app, alice, directId, { body: "burst", clientMessageId })));
    expect(new Set(results.map((r) => r.body.message.id)).size).toBe(1);
    expect((await as(app, bob).get(`/api/v1/messages/${directId}`)).body.items).toHaveLength(1);
  });

  it("scopes the key per sender and per conversation", async () => {
    const clientMessageId = generateId();
    await sendMessage(app, alice, directId, { body: "a", clientMessageId });
    // Another sender may use the same key (keys are per sender).
    expect((await sendMessage(app, bob, directId, { body: "b", clientMessageId })).status).toBe(201);
    // Reusing a key in another conversation is rejected rather than silently returning the wrong message.
    const other = await createDirectConversation(app, alice, carol);
    expect((await sendMessage(app, alice, other, { body: "c", clientMessageId })).status).toBe(409);
    expect((await sendMessage(app, alice, directId, { body: "x", clientMessageId: "not-a-uuid" })).status).toBe(400);
  });

  it("a retried send is still refused once the sender lost access", async () => {
    const clientMessageId = generateId();
    await sendMessage(app, alice, directId, { body: "first", clientMessageId });
    const res = await sendMessage(app, carol, directId, { body: "first", clientMessageId });
    expect(res.status).toBe(403);
  });

  it("syncs edits, deletes and read state to the user's other devices", async () => {
    const message = (await sendMessage(app, bob, directId, { body: "hello" })).body.message;
    const mine = (await sendMessage(app, alice, directId, { body: "typo" })).body.message;
    gateway.sentEvents.length = 0;

    await as(app, alice).patch(`/api/v1/messages/${directId}/${mine.id}`).send({ body: "fixed" });
    await as(app, alice).post(`/api/v1/messages/${directId}/read`).send({ upToMessageId: message.id });
    await as(app, alice).delete(`/api/v1/messages/${directId}/${mine.id}`);

    const aliceEvents = gateway.eventsFor(alice.userId).map((e) => e.type);
    expect(aliceEvents).toEqual(expect.arrayContaining(["message:updated", "conversation:unread", "message:deleted"]));
    const unread = gateway.eventsFor(alice.userId).find((e) => e.type === "conversation:unread");
    expect(unread).toMatchObject({ conversationId: directId, unreadCount: 0 });
    expect(gateway.eventsFor(carol.userId)).toHaveLength(0);
  });
});
