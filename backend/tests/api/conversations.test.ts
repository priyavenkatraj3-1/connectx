import type { Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { createTestDb } from "../helpers/testDb";
import { signupTestUser } from "../helpers/testUser";

describe("Conversations API", () => {
  let app: Express;

  beforeEach(async () => {
    const db = await createTestDb();
    app = createApp({ db }).app;
  });

  it("creates a direct conversation between two users", async () => {
    const alice = await signupTestUser(app, { displayName: "Alice" });
    const bob = await signupTestUser(app, { displayName: "Bob" });

    const res = await request(app)
      .post("/api/v1/conversations/direct")
      .set("Authorization", `Bearer ${alice.accessToken}`)
      .send({ userId: bob.userId });

    expect(res.status).toBe(200);
    expect(res.body.conversation.type).toBe("direct");
  });

  it("returns the same conversation when called again for the same pair, in either direction", async () => {
    const alice = await signupTestUser(app, { displayName: "Alice" });
    const bob = await signupTestUser(app, { displayName: "Bob" });

    const first = await request(app)
      .post("/api/v1/conversations/direct")
      .set("Authorization", `Bearer ${alice.accessToken}`)
      .send({ userId: bob.userId });

    const second = await request(app)
      .post("/api/v1/conversations/direct")
      .set("Authorization", `Bearer ${bob.accessToken}`)
      .send({ userId: alice.userId });

    expect(first.body.conversation.id).toBe(second.body.conversation.id);
  });

  it("rejects starting a conversation with yourself", async () => {
    const alice = await signupTestUser(app, { displayName: "Alice" });
    const res = await request(app)
      .post("/api/v1/conversations/direct")
      .set("Authorization", `Bearer ${alice.accessToken}`)
      .send({ userId: alice.userId });
    expect(res.status).toBe(400);
  });

  it("lists conversations for a user with the other participant's profile", async () => {
    const alice = await signupTestUser(app, { displayName: "Alice" });
    const bob = await signupTestUser(app, { displayName: "Bob" });

    await request(app)
      .post("/api/v1/conversations/direct")
      .set("Authorization", `Bearer ${alice.accessToken}`)
      .send({ userId: bob.userId });

    const res = await request(app).get("/api/v1/conversations").set("Authorization", `Bearer ${alice.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.conversations).toHaveLength(1);
    expect(res.body.conversations[0].otherParticipant.displayName).toBe("Bob");
    expect(res.body.conversations[0].unreadCount).toBe(0);
    expect(res.body.conversations[0].lastMessage).toBeNull();
  });

  it("denies access to a conversation's details for a non-member", async () => {
    const alice = await signupTestUser(app, { displayName: "Alice" });
    const bob = await signupTestUser(app, { displayName: "Bob" });
    const eve = await signupTestUser(app, { displayName: "Eve" });

    const created = await request(app)
      .post("/api/v1/conversations/direct")
      .set("Authorization", `Bearer ${alice.accessToken}`)
      .send({ userId: bob.userId });
    const conversationId = created.body.conversation.id as string;

    const res = await request(app)
      .get(`/api/v1/conversations/${conversationId}`)
      .set("Authorization", `Bearer ${eve.accessToken}`);

    expect(res.status).toBe(403);
  });

  it("requires authentication", async () => {
    const res = await request(app).get("/api/v1/conversations");
    expect(res.status).toBe(401);
  });
});
