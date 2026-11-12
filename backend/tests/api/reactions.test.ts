import type { Express } from "express";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import type { Container } from "../../src/container";
import { as } from "../helpers/api";
import { FakeRealtimeGateway } from "../helpers/fakeRealtimeGateway";
import { createDirectConversation, createGroup, sendMessage } from "../helpers/fixtures";
import { createTestDb } from "../helpers/testDb";
import { signupTestUser, type TestUser } from "../helpers/testUser";

describe("Message reactions API", () => {
  let app: Express;
  let container: Container;
  let gateway: FakeRealtimeGateway;
  let alice: TestUser;
  let bob: TestUser;
  let eve: TestUser;
  let conversationId: string;
  let messageId: string;

  const reactUrl = (convId: string, msgId: string) => `/api/v1/messages/${convId}/${msgId}/reaction`;

  beforeEach(async () => {
    const db = await createTestDb();
    ({ app, container } = createApp({ db }));
    gateway = new FakeRealtimeGateway();
    container.realtimeGatewayRef.current = gateway;
    alice = await signupTestUser(app, { displayName: "Alice", email: "alice@example.com" });
    bob = await signupTestUser(app, { displayName: "Bob", email: "bob@example.com" });
    eve = await signupTestUser(app, { displayName: "Eve", email: "eve@example.com" });
    conversationId = await createDirectConversation(app, alice, bob);
    messageId = (await sendMessage(app, alice, conversationId, { body: "Lunch?" })).body.message.id;
  });

  it("sets, replaces and removes your one reaction, and lists reactions with the message", async () => {
    const first = await as(app, bob).put(reactUrl(conversationId, messageId)).send({ emoji: "👍" });
    expect(first.status).toBe(200);
    expect(first.body.reactions).toEqual([{ emoji: "👍", count: 1, userIds: [bob.userId] }]);

    await as(app, alice).put(reactUrl(conversationId, messageId)).send({ emoji: "👍" });
    const replaced = await as(app, bob).put(reactUrl(conversationId, messageId)).send({ emoji: "😂" });
    expect(replaced.body.reactions).toEqual([
      { emoji: "👍", count: 1, userIds: [alice.userId] },
      { emoji: "😂", count: 1, userIds: [bob.userId] },
    ]);

    const listed = await as(app, alice).get(`/api/v1/messages/${conversationId}`);
    expect(listed.body.items[0].reactions).toEqual(replaced.body.reactions);

    const removed = await as(app, bob).delete(reactUrl(conversationId, messageId));
    expect(removed.status).toBe(200);
    expect(removed.body.reactions).toEqual([{ emoji: "👍", count: 1, userIds: [alice.userId] }]);
    // Removing a reaction you don't have is a no-op, not an error.
    expect((await as(app, bob).delete(reactUrl(conversationId, messageId))).status).toBe(200);
  });

  it("broadcasts the new summary to every member", async () => {
    gateway.sentEvents.length = 0;
    await as(app, bob).put(reactUrl(conversationId, messageId)).send({ emoji: "❤️" });
    const events = gateway.sentEvents.filter((s) => s.event.type === "message:reactions");
    expect(events.map((s) => s.userId).sort()).toEqual([alice.userId, bob.userId].sort());
    expect(events[0]!.event).toEqual({
      type: "message:reactions",
      conversationId,
      messageId,
      reactions: [{ emoji: "❤️", count: 1, userIds: [bob.userId] }],
    });
  });

  it("refuses outsiders, mismatched conversations, deleted messages and history from before you joined", async () => {
    expect((await as(app, eve).put(reactUrl(conversationId, messageId)).send({ emoji: "👍" })).status).toBe(403);

    const otherConversation = await createDirectConversation(app, alice, eve);
    // A member of another chat can't react to this message by putting it under their own chat's URL.
    expect((await as(app, eve).put(reactUrl(otherConversation, messageId)).send({ emoji: "👍" })).status).toBe(404);

    await as(app, alice).delete(`/api/v1/messages/${conversationId}/${messageId}`);
    expect((await as(app, bob).put(reactUrl(conversationId, messageId)).send({ emoji: "👍" })).status).toBe(404);

    const { groupId, conversationId: groupConversation } = await createGroup(app, alice, [bob]);
    const before = (await sendMessage(app, alice, groupConversation, { body: "Before Eve" })).body.message.id;
    await as(app, alice).post(`/api/v1/groups/${groupId}/members`).send({ userIds: [eve.userId] });
    expect((await as(app, eve).put(reactUrl(groupConversation, before)).send({ emoji: "👍" })).status).toBe(404);
  });

  it("accepts single emoji (skin tones, flags, ZWJ, keycaps) and rejects anything else", async () => {
    for (const emoji of ["👍🏽", "🇮🇳", "👨‍👩‍👧", "1️⃣", "❤️"]) {
      const res = await as(app, bob).put(reactUrl(conversationId, messageId)).send({ emoji });
      expect(res.status, emoji).toBe(200);
    }
    for (const emoji of ["", "a", "lol", "👍 ", " 👍", "👍a", "<script>", "👍".repeat(9), 5]) {
      const res = await as(app, bob).put(reactUrl(conversationId, messageId)).send({ emoji });
      expect(res.status, String(emoji)).toBe(400);
    }
    expect((await as(app, bob).put(reactUrl(conversationId, "not-a-uuid")).send({ emoji: "👍" })).status).toBe(400);
  });

  it("keeps one reaction per person even when two arrive at once", async () => {
    await Promise.all([
      as(app, bob).put(reactUrl(conversationId, messageId)).send({ emoji: "👍" }),
      as(app, bob).put(reactUrl(conversationId, messageId)).send({ emoji: "🎉" }),
    ]);
    const listed = await as(app, bob).get(`/api/v1/messages/${conversationId}`);
    const reactions = listed.body.items[0].reactions as Array<{ count: number; userIds: string[] }>;
    expect(reactions).toHaveLength(1);
    expect(reactions[0]!.userIds).toEqual([bob.userId]);
  });

  it("requires authentication", async () => {
    const { default: request } = await import("supertest");
    expect((await request(app).put(reactUrl(conversationId, messageId)).send({ emoji: "👍" })).status).toBe(401);
  });
});
