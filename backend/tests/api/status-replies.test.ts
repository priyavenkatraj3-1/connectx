import type { Express } from "express";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import type { Container } from "../../src/container";
import type { DatabaseClient } from "../../src/db/pool";
import { as } from "../helpers/api";
import { FakeRealtimeGateway } from "../helpers/fakeRealtimeGateway";
import { createDirectConversation, SAMPLE_FILES, sendMessage, uploadStatusMedia } from "../helpers/fixtures";
import { createTestDb } from "../helpers/testDb";
import { signupTestUser, type TestUser } from "../helpers/testUser";

describe("Status replies API", () => {
  let app: Express;
  let db: DatabaseClient;
  let container: Container;
  let gateway: FakeRealtimeGateway;
  let alice: TestUser;
  let bob: TestUser;
  let eve: TestUser;

  const postStatus = async (owner: TestUser, body: Record<string, unknown>) => {
    const res = await as(app, owner).post("/api/v1/statuses").send(body);
    if (res.status !== 201) throw new Error(`status create failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.status.id as string;
  };
  const reply = (user: TestUser, statusId: string, body: unknown) => as(app, user).post(`/api/v1/statuses/${statusId}/reply`).send({ body });

  beforeEach(async () => {
    db = await createTestDb();
    ({ app, container } = createApp({ db }));
    gateway = new FakeRealtimeGateway();
    container.realtimeGatewayRef.current = gateway;
    alice = await signupTestUser(app, { displayName: "Alice", email: "alice@example.com" });
    bob = await signupTestUser(app, { displayName: "Bob", email: "bob@example.com" });
    eve = await signupTestUser(app, { displayName: "Eve", email: "eve@example.com" });
  });

  it("sends a direct message to the owner that references the status, creating the chat if needed", async () => {
    const statusId = await postStatus(alice, { type: "text", text: "Climbing day!", privacy: { visibility: "selected", userIds: [bob.userId] } });

    const res = await reply(bob, statusId, "Have fun 🧗");
    expect(res.status).toBe(201);
    expect(res.body.message).toMatchObject({
      senderId: bob.userId,
      body: "Have fun 🧗",
      statusReply: { statusId, type: "text", preview: "Climbing day!" },
    });

    // It's a normal message in their direct chat — Alice sees it there, live and in history.
    const conversationId = res.body.conversationId as string;
    const history = await as(app, alice).get(`/api/v1/messages/${conversationId}`);
    expect(history.body.items[0]).toMatchObject({ body: "Have fun 🧗", statusReply: { statusId } });
    expect(gateway.sentEvents.some((e) => e.userId === alice.userId && e.event.type === "message:new")).toBe(true);

    // Replying again reuses the same chat.
    expect((await reply(bob, statusId, "Send pics")).body.conversationId).toBe(conversationId);
    expect(await createDirectConversation(app, alice, bob)).toBe(conversationId);
  });

  it("keeps the reference readable after the status expires and is swept", async () => {
    const statusId = await postStatus(alice, { type: "text", text: "Short-lived", privacy: { visibility: "selected", userIds: [bob.userId] } });
    const { conversationId } = (await reply(bob, statusId, "Nice")).body;

    await db.query("UPDATE statuses SET created_at = now() - interval '25 hours', expires_at = now() - interval '1 minute' WHERE id = $1", [statusId]);
    await container.statusesService.sweepExpired();

    const history = await as(app, alice).get(`/api/v1/messages/${conversationId}`);
    expect(history.body.items[0].statusReply).toEqual({ statusId, type: "text", preview: "Short-lived" });
    // …but nobody can reply to it any more.
    expect((await reply(bob, statusId, "Late")).status).toBe(404);
  });

  it("refuses statuses you can't see (404), your own status (400) and empty replies (400)", async () => {
    const statusId = await postStatus(alice, { type: "text", text: "Bob only", privacy: { visibility: "selected", userIds: [bob.userId] } });

    expect((await reply(eve, statusId, "hi")).status).toBe(404);
    expect((await reply(eve, "00000000-0000-4000-8000-000000000000", "hi")).status).toBe(404);
    expect((await reply(alice, statusId, "talking to myself")).status).toBe(400);
    expect((await reply(bob, statusId, "   ")).status).toBe(400);
    expect((await reply(bob, statusId, "x".repeat(4001))).status).toBe(400);
    expect((await reply(bob, "not-a-uuid", "hi")).status).toBe(400);
    // Eve's refused attempt created no chat with Alice.
    expect((await as(app, eve).get("/api/v1/conversations")).body.conversations).toEqual([]);
  });

  it("shortens long text, and media statuses carry their caption or no preview — never the media", async () => {
    const long = "a".repeat(300);
    const textId = await postStatus(alice, { type: "text", text: long, privacy: { visibility: "selected", userIds: [bob.userId] } });
    const preview = (await reply(bob, textId, "wow")).body.message.statusReply.preview as string;
    expect(preview).toHaveLength(100);
    expect(preview.endsWith("…")).toBe(true);

    const upload = await uploadStatusMedia(app, alice, "beach.png", SAMPLE_FILES.png, "image/png");
    const imageId = await postStatus(alice, { type: "image", attachmentId: upload.body.attachment.id, privacy: { visibility: "selected", userIds: [bob.userId] } });
    const res = await reply(bob, imageId, "Gorgeous");
    expect(res.body.message.statusReply).toEqual({ statusId: imageId, type: "image", preview: null });
    expect(res.body.message.attachment).toBeNull();
  });

  it("a client can't attach a status reference to an ordinary message", async () => {
    const conversationId = await createDirectConversation(app, bob, alice);
    const res = await sendMessage(app, bob, conversationId, {
      body: "forged",
      statusReply: { statusId: "00000000-0000-4000-8000-000000000000", type: "text", preview: "fake" },
    });
    expect(res.status).toBe(201);
    expect(res.body.message.statusReply).toBeNull();
  });
});
