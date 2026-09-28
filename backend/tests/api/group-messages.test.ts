import type { Express } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import type { Container } from "../../src/container";
import { FakeRealtimeGateway } from "../helpers/fakeRealtimeGateway";
import { createGroup, sendMessage } from "../helpers/fixtures";
import { createTestDb } from "../helpers/testDb";
import { signupTestUser, type TestUser } from "../helpers/testUser";

function auth(user: TestUser) {
  return { Authorization: `Bearer ${user.accessToken}` };
}

describe("Group messages", () => {
  let app: Express;
  let container: Container;
  let gateway: FakeRealtimeGateway;
  let alice: TestUser;
  let bob: TestUser;
  let carol: TestUser;
  let eve: TestUser;
  let conversationId: string;

  beforeAll(async () => {
    const db = await createTestDb();
    ({ app, container } = createApp({ db }));
    alice = await signupTestUser(app, { displayName: "Alice" });
    bob = await signupTestUser(app, { displayName: "Bob" });
    carol = await signupTestUser(app, { displayName: "Carol" });
    eve = await signupTestUser(app, { displayName: "Eve" });
  });

  beforeEach(async () => {
    gateway = new FakeRealtimeGateway();
    container.realtimeGatewayRef.current = gateway;
    ({ conversationId } = await createGroup(app, alice, [bob, carol]));
    gateway.sentEvents.length = 0;
  });

  it("persists a group message with sender identity and fans it out to every other member", async () => {
    const res = await sendMessage(app, alice, conversationId, { body: "Hello group" });
    expect(res.status).toBe(201);
    expect(res.body.message).toMatchObject({
      conversationId,
      senderId: alice.userId,
      sender: { id: alice.userId, displayName: "Alice" },
      body: "Hello group",
      contentType: "text",
      status: "sent",
      replyTo: null,
      mentions: [],
      attachment: null,
    });

    for (const member of [bob, carol]) {
      expect(gateway.eventsFor(member.userId)).toContainEqual(
        expect.objectContaining({ type: "message:new", conversationId, message: expect.objectContaining({ body: "Hello group" }) })
      );
    }
    expect(gateway.eventsFor(eve.userId)).toEqual([]);

    const history = await request(app).get(`/api/v1/messages/${conversationId}`).set(auth(carol));
    expect(history.body.items).toHaveLength(1);
    expect(history.body.items[0].sender.displayName).toBe("Alice");
  });

  it("blocks non-members from reading, sending, editing, deleting or marking read", async () => {
    const sent = await sendMessage(app, alice, conversationId, { body: "members only" });
    const messageId = sent.body.message.id as string;

    expect((await request(app).get(`/api/v1/messages/${conversationId}`).set(auth(eve))).status).toBe(403);
    expect((await sendMessage(app, eve, conversationId, { body: "let me in" })).status).toBe(403);
    expect(
      (await request(app).patch(`/api/v1/messages/${conversationId}/${messageId}`).set(auth(eve)).send({ body: "x" })).status
    ).toBe(403);
    expect((await request(app).delete(`/api/v1/messages/${conversationId}/${messageId}`).set(auth(eve))).status).toBe(403);
    expect(
      (await request(app).post(`/api/v1/messages/${conversationId}/read`).set(auth(eve)).send({ upToMessageId: messageId })).status
    ).toBe(403);
  });

  it("rejects marking read from another user's service call path (authorization is enforced in the service, not only middleware)", async () => {
    const sent = await sendMessage(app, alice, conversationId, { body: "ws path" });
    await expect(container.messagesService.markRead(conversationId, eve.userId, sent.body.message.id)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  describe("delivery and read status", () => {
    it("is 'delivered' only when every recipient is online, then 'read' only once everyone has read", async () => {
      gateway.onlineUserIds = new Set([bob.userId]);
      const partial = await sendMessage(app, alice, conversationId, { body: "one online" });
      expect(partial.body.message.status).toBe("sent");

      gateway.onlineUserIds = new Set([bob.userId, carol.userId]);
      const all = await sendMessage(app, alice, conversationId, { body: "all online" });
      expect(all.body.message.status).toBe("delivered");
      expect(gateway.eventsFor(alice.userId)).toContainEqual({
        type: "message:status",
        conversationId,
        messageIds: [all.body.message.id],
        status: "delivered",
      });

      const lastId = all.body.message.id as string;
      await request(app).post(`/api/v1/messages/${conversationId}/read`).set(auth(bob)).send({ upToMessageId: lastId });

      let history = await request(app).get(`/api/v1/messages/${conversationId}`).set(auth(alice));
      expect(history.body.items.map((m: { status: string }) => m.status)).toEqual(["sent", "delivered"]);

      gateway.sentEvents.length = 0;
      await request(app).post(`/api/v1/messages/${conversationId}/read`).set(auth(carol)).send({ upToMessageId: lastId });

      history = await request(app).get(`/api/v1/messages/${conversationId}`).set(auth(alice));
      expect(history.body.items.map((m: { status: string }) => m.status)).toEqual(["read", "read"]);

      const statusEvent = gateway.eventsFor(alice.userId).find((e) => e.type === "message:status");
      expect(statusEvent).toMatchObject({ type: "message:status", conversationId, status: "read" });
      expect(statusEvent && "messageIds" in statusEvent ? [...statusEvent.messageIds].sort() : []).toEqual(
        [partial.body.message.id, lastId].sort()
      );
    });

    it("tracks unread counts per member and syncs the reader's other sessions", async () => {
      await sendMessage(app, alice, conversationId, { body: "one" });
      const second = await sendMessage(app, bob, conversationId, { body: "two" });

      const unreadFor = async (user: TestUser) => {
        const res = await request(app).get("/api/v1/conversations").set(auth(user));
        return res.body.conversations.find((c: { id: string }) => c.id === conversationId).unreadCount as number;
      };
      expect(await unreadFor(carol)).toBe(2);
      expect(await unreadFor(alice)).toBe(1); // own messages never count
      expect(await unreadFor(bob)).toBe(1);

      await request(app).post(`/api/v1/messages/${conversationId}/read`).set(auth(carol)).send({ upToMessageId: second.body.message.id });
      expect(await unreadFor(carol)).toBe(0);
      expect(gateway.eventsFor(carol.userId)).toContainEqual({ type: "conversation:unread", conversationId, unreadCount: 0 });
    });

    it("orders the conversation list by latest message and shows a sender-labelled preview", async () => {
      const { conversationId: otherGroup } = await createGroup(app, alice, [bob], "Older Group");
      await sendMessage(app, bob, otherGroup, { body: "in the other group" });
      await sendMessage(app, carol, conversationId, { body: "latest" });

      const res = await request(app).get("/api/v1/conversations").set(auth(bob));
      const ids = res.body.conversations.map((c: { id: string }) => c.id);
      expect(ids.indexOf(conversationId)).toBeLessThan(ids.indexOf(otherGroup));
      expect(res.body.conversations[0].lastMessage).toMatchObject({ body: "latest", senderDisplayName: "Carol" });
    });

    it("rejects marking read up to a message from a different conversation", async () => {
      const { conversationId: otherGroup } = await createGroup(app, alice, [bob]);
      const foreign = await sendMessage(app, alice, otherGroup, { body: "elsewhere" });
      const res = await request(app)
        .post(`/api/v1/messages/${conversationId}/read`)
        .set(auth(bob))
        .send({ upToMessageId: foreign.body.message.id });
      expect(res.status).toBe(400);
    });
  });

  describe("mentions", () => {
    it("stores mentions of group members and returns them with display names", async () => {
      const res = await sendMessage(app, alice, conversationId, {
        body: "@Bob @Carol lunch?",
        mentionedUserIds: [bob.userId, carol.userId, bob.userId],
      });
      expect(res.status).toBe(201);
      const mentioned = res.body.message.mentions.map((m: { displayName: string }) => m.displayName).sort();
      expect(mentioned).toEqual(["Bob", "Carol"]);
    });

    it("rejects mentioning someone who isn't a member", async () => {
      const res = await sendMessage(app, alice, conversationId, { body: "@Eve hi", mentionedUserIds: [eve.userId] });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/members of this conversation/);
    });

    it("silently drops a self-mention", async () => {
      const res = await sendMessage(app, alice, conversationId, { body: "@Alice note to self", mentionedUserIds: [alice.userId] });
      expect(res.status).toBe(201);
      expect(res.body.message.mentions).toEqual([]);
    });
  });

  describe("replies", () => {
    it("attaches a preview of the original message", async () => {
      const original = await sendMessage(app, bob, conversationId, { body: "Who's bringing snacks?" });
      const reply = await sendMessage(app, alice, conversationId, { body: "Me!", replyToMessageId: original.body.message.id });
      expect(reply.status).toBe(201);
      expect(reply.body.message.replyTo).toMatchObject({
        id: original.body.message.id,
        senderId: bob.userId,
        senderDisplayName: "Bob",
        body: "Who's bringing snacks?",
        deleted: false,
      });
    });

    it("rejects replying to a message from another conversation or a deleted one", async () => {
      const { conversationId: otherGroup } = await createGroup(app, alice, [bob]);
      const foreign = await sendMessage(app, alice, otherGroup, { body: "elsewhere" });
      expect(
        (await sendMessage(app, alice, conversationId, { body: "reply", replyToMessageId: foreign.body.message.id })).status
      ).toBe(400);

      const doomed = await sendMessage(app, bob, conversationId, { body: "soon gone" });
      await request(app).delete(`/api/v1/messages/${conversationId}/${doomed.body.message.id}`).set(auth(bob));
      expect(
        (await sendMessage(app, alice, conversationId, { body: "reply", replyToMessageId: doomed.body.message.id })).status
      ).toBe(400);
    });

    it("shows a reply to a later-deleted message as deleted, without its content", async () => {
      const original = await sendMessage(app, bob, conversationId, { body: "secret" });
      await sendMessage(app, alice, conversationId, { body: "replying", replyToMessageId: original.body.message.id });
      await request(app).delete(`/api/v1/messages/${conversationId}/${original.body.message.id}`).set(auth(bob));

      const history = await request(app).get(`/api/v1/messages/${conversationId}`).set(auth(carol));
      expect(history.body.items).toHaveLength(1);
      expect(history.body.items[0].replyTo).toMatchObject({ deleted: true, body: null });
    });
  });

  describe("editing", () => {
    it("lets the author edit, updates mentions, and broadcasts the update", async () => {
      const sent = await sendMessage(app, alice, conversationId, { body: "typo", mentionedUserIds: [bob.userId] });
      const messageId = sent.body.message.id as string;

      const res = await request(app)
        .patch(`/api/v1/messages/${conversationId}/${messageId}`)
        .set(auth(alice))
        .send({ body: "fixed @Carol", mentionedUserIds: [carol.userId] });
      expect(res.status).toBe(200);
      expect(res.body.message.body).toBe("fixed @Carol");
      expect(res.body.message.editedAt).not.toBeNull();
      expect(res.body.message.mentions).toEqual([{ userId: carol.userId, displayName: "Carol" }]);
      expect(gateway.eventsFor(bob.userId)).toContainEqual(
        expect.objectContaining({ type: "message:updated", conversationId, message: expect.objectContaining({ body: "fixed @Carol" }) })
      );
    });

    it("forbids editing someone else's message, and rejects empty text", async () => {
      const sent = await sendMessage(app, alice, conversationId, { body: "mine" });
      const messageId = sent.body.message.id as string;

      expect(
        (await request(app).patch(`/api/v1/messages/${conversationId}/${messageId}`).set(auth(bob)).send({ body: "hijacked" })).status
      ).toBe(403);
      expect(
        (await request(app).patch(`/api/v1/messages/${conversationId}/${messageId}`).set(auth(alice)).send({ body: "  " })).status
      ).toBe(400);
    });

    it("returns 404 for an unknown message and 400 for a malformed ID", async () => {
      expect(
        (
          await request(app)
            .patch(`/api/v1/messages/${conversationId}/00000000-0000-4000-8000-000000000000`)
            .set(auth(alice))
            .send({ body: "x" })
        ).status
      ).toBe(404);
      expect(
        (await request(app).patch(`/api/v1/messages/${conversationId}/nope`).set(auth(alice)).send({ body: "x" })).status
      ).toBe(400);
    });
  });

  describe("deleting", () => {
    it("lets the author delete; the message disappears for everyone and a delete event is broadcast", async () => {
      const sent = await sendMessage(app, alice, conversationId, { body: "delete me" });
      const messageId = sent.body.message.id as string;

      const res = await request(app).delete(`/api/v1/messages/${conversationId}/${messageId}`).set(auth(alice));
      expect(res.status).toBe(204);
      expect(gateway.eventsFor(carol.userId)).toContainEqual({ type: "message:deleted", conversationId, messageId });

      const history = await request(app).get(`/api/v1/messages/${conversationId}`).set(auth(bob));
      expect(history.body.items).toEqual([]);

      const row = await container.db.query<{ body: string | null; deleted_at: Date | null }>(
        "SELECT body, deleted_at FROM messages WHERE id = $1",
        [messageId]
      );
      expect(row.rows[0]).toMatchObject({ body: null });
      expect(row.rows[0]!.deleted_at).not.toBeNull();

      // Deleting again, or editing a deleted message, is a 404.
      expect((await request(app).delete(`/api/v1/messages/${conversationId}/${messageId}`).set(auth(alice))).status).toBe(404);
    });

    it("forbids deleting someone else's message, even as the group owner", async () => {
      const sent = await sendMessage(app, bob, conversationId, { body: "bob's" });
      expect((await request(app).delete(`/api/v1/messages/${conversationId}/${sent.body.message.id}`).set(auth(alice))).status).toBe(
        403
      );
    });
  });

  it("keeps direct conversations working alongside groups", async () => {
    const direct = await request(app).post("/api/v1/conversations/direct").set(auth(alice)).send({ userId: eve.userId });
    const directId = direct.body.conversation.id as string;
    const sent = await sendMessage(app, alice, directId, { body: "just us" });
    expect(sent.status).toBe(201);

    const list = await request(app).get("/api/v1/conversations").set(auth(eve));
    expect(list.body.conversations).toHaveLength(1);
    expect(list.body.conversations[0]).toMatchObject({
      id: directId,
      type: "direct",
      group: null,
      otherParticipant: { id: alice.userId, displayName: "Alice" },
      unreadCount: 1,
    });
  });
});
