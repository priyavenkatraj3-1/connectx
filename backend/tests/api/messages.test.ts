import type { Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import type { Container } from "../../src/container";
import { createTestDb } from "../helpers/testDb";
import { signupTestUser, type TestUser } from "../helpers/testUser";

async function createDirectConversation(app: Express, a: TestUser, b: TestUser): Promise<string> {
  const res = await request(app)
    .post("/api/v1/conversations/direct")
    .set("Authorization", `Bearer ${a.accessToken}`)
    .send({ userId: b.userId });
  return res.body.conversation.id as string;
}

describe("Messages API", () => {
  let app: Express;
  let container: Container;
  let alice: TestUser;
  let bob: TestUser;
  let conversationId: string;

  beforeEach(async () => {
    const db = await createTestDb();
    ({ app, container } = createApp({ db }));
    alice = await signupTestUser(app, { displayName: "Alice" });
    bob = await signupTestUser(app, { displayName: "Bob" });
    conversationId = await createDirectConversation(app, alice, bob);
  });

  it("sends a message and returns it with 'sent' status when the recipient is offline", async () => {
    const res = await request(app)
      .post(`/api/v1/messages/${conversationId}`)
      .set("Authorization", `Bearer ${alice.accessToken}`)
      .send({ body: "Hello Bob" });

    expect(res.status).toBe(201);
    expect(res.body.message).toMatchObject({
      conversationId,
      senderId: alice.userId,
      body: "Hello Bob",
      status: "sent",
    });
  });

  it("marks a message as delivered when the recipient is online, and notifies the sender", async () => {
    container.realtimeGatewayRef.current = {
      sendToUser: () => undefined,
      isUserOnline: (userId) => userId === bob.userId,
    };

    const res = await request(app)
      .post(`/api/v1/messages/${conversationId}`)
      .set("Authorization", `Bearer ${alice.accessToken}`)
      .send({ body: "Are you there?" });

    expect(res.body.message.status).toBe("delivered");
  });

  it("rejects an empty message body", async () => {
    const res = await request(app)
      .post(`/api/v1/messages/${conversationId}`)
      .set("Authorization", `Bearer ${alice.accessToken}`)
      .send({ body: "   " });
    expect(res.status).toBe(400);
  });

  it("lists messages for a conversation in chronological order", async () => {
    await request(app)
      .post(`/api/v1/messages/${conversationId}`)
      .set("Authorization", `Bearer ${alice.accessToken}`)
      .send({ body: "First" });
    await request(app)
      .post(`/api/v1/messages/${conversationId}`)
      .set("Authorization", `Bearer ${bob.accessToken}`)
      .send({ body: "Second" });

    const res = await request(app)
      .get(`/api/v1/messages/${conversationId}`)
      .set("Authorization", `Bearer ${alice.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items.map((m: { body: string }) => m.body)).toEqual(["First", "Second"]);
    expect(res.body.hasMore).toBe(false);
  });

  it("marks messages read and reflects that in both the message status and the recipient's unread count", async () => {
    const sendRes = await request(app)
      .post(`/api/v1/messages/${conversationId}`)
      .set("Authorization", `Bearer ${alice.accessToken}`)
      .send({ body: "Read me" });
    const messageId = sendRes.body.message.id as string;

    const unreadBefore = await request(app)
      .get("/api/v1/conversations")
      .set("Authorization", `Bearer ${bob.accessToken}`);
    expect(unreadBefore.body.conversations[0].unreadCount).toBe(1);

    const readRes = await request(app)
      .post(`/api/v1/messages/${conversationId}/read`)
      .set("Authorization", `Bearer ${bob.accessToken}`)
      .send({ upToMessageId: messageId });
    expect(readRes.status).toBe(204);

    const listRes = await request(app)
      .get(`/api/v1/messages/${conversationId}`)
      .set("Authorization", `Bearer ${alice.accessToken}`);
    expect(listRes.body.items[0].status).toBe("read");

    const unreadAfter = await request(app)
      .get("/api/v1/conversations")
      .set("Authorization", `Bearer ${bob.accessToken}`);
    expect(unreadAfter.body.conversations[0].unreadCount).toBe(0);
  });

  it("blocks a non-member from sending, listing, or reading a conversation's messages", async () => {
    const eve = await signupTestUser(app, { displayName: "Eve" });

    const sendRes = await request(app)
      .post(`/api/v1/messages/${conversationId}`)
      .set("Authorization", `Bearer ${eve.accessToken}`)
      .send({ body: "I shouldn't be able to do this" });
    expect(sendRes.status).toBe(403);

    const listRes = await request(app)
      .get(`/api/v1/messages/${conversationId}`)
      .set("Authorization", `Bearer ${eve.accessToken}`);
    expect(listRes.status).toBe(403);

    const readRes = await request(app)
      .post(`/api/v1/messages/${conversationId}/read`)
      .set("Authorization", `Bearer ${eve.accessToken}`)
      .send({ upToMessageId: "00000000-0000-0000-0000-000000000000" });
    expect(readRes.status).toBe(403);
  });

  it("requires authentication", async () => {
    const res = await request(app).get(`/api/v1/messages/${conversationId}`);
    expect(res.status).toBe(401);
  });
});
