import type { Express } from "express";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import request from "supertest";
import type { WebSocket } from "ws";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import type { Container } from "../../src/container";
import { attachWebSocketGateway, WS_PATH } from "../../src/realtime/ws.server";
import { createGroup, sendMessage } from "../helpers/fixtures";
import { createTestDb } from "../helpers/testDb";
import { signupTestUser, type TestUser } from "../helpers/testUser";
import { connect, createMessageQueue, delay } from "../helpers/wsClient";

describe("Realtime group events over WebSocket", () => {
  let httpServer: Server;
  let baseWsUrl: string;
  let app: Express;
  let container: Container;
  let alice: TestUser;
  let bob: TestUser;
  let carol: TestUser;
  let eve: TestUser;
  let sockets: WebSocket[] = [];

  beforeAll(async () => {
    const db = await createTestDb();
    ({ app, container } = createApp({ db }));

    httpServer = createServer(app);
    container.realtimeGatewayRef.current = attachWebSocketGateway(httpServer, {
      onClientRead: (userId, convId, upToMessageId) => container.messagesService.markRead(convId, userId, upToMessageId),
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    baseWsUrl = `ws://127.0.0.1:${(httpServer.address() as AddressInfo).port}${WS_PATH}`;

    alice = await signupTestUser(app, { displayName: "Alice" });
    bob = await signupTestUser(app, { displayName: "Bob" });
    carol = await signupTestUser(app, { displayName: "Carol" });
    eve = await signupTestUser(app, { displayName: "Eve" });
  });

  afterEach(() => {
    for (const socket of sockets) socket.close();
    sockets = [];
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  async function open(user: TestUser) {
    const socket = await connect(baseWsUrl, user.accessToken);
    sockets.push(socket);
    return createMessageQueue(socket);
  }

  it("delivers a group message to every online member, and reports aggregate delivery to the sender", async () => {
    const { conversationId } = await createGroup(app, alice, [bob, carol]);
    const [aliceQ, bobQ, carolQ, eveQ] = [await open(alice), await open(bob), await open(carol), await open(eve)];
    await delay(50);

    const sent = await sendMessage(app, alice, conversationId, { body: "hi all", mentionedUserIds: [carol.userId] });
    expect(sent.status).toBe(201);

    for (const queue of [bobQ, carolQ]) {
      const event = await queue.nextOfType("message:new");
      expect(event).toMatchObject({
        conversationId,
        message: { body: "hi all", sender: { displayName: "Alice" }, mentions: [{ userId: carol.userId }] },
      });
    }
    expect(await aliceQ.nextOfType("message:status")).toEqual({
      type: "message:status",
      conversationId,
      messageIds: [sent.body.message.id],
      status: "delivered",
    });

    // The outsider receives nothing.
    await expect(eveQ.nextOfType("message:new", 300)).rejects.toThrow(/Timed out/);
  });

  it("reports 'read' to the sender only after every member reads, via client-sent read events", async () => {
    const { conversationId } = await createGroup(app, alice, [bob, carol]);
    const [aliceQ, bobQ, carolQ] = [await open(alice), await open(bob), await open(carol)];
    await delay(50);

    const sent = await sendMessage(app, alice, conversationId, { body: "read me" });
    const messageId = sent.body.message.id as string;
    await bobQ.nextOfType("message:new");
    await carolQ.nextOfType("message:new");
    await aliceQ.nextOfType("message:status"); // delivered

    sockets[1]!.send(JSON.stringify({ type: "message:read", conversationId, upToMessageId: messageId }));
    expect(await bobQ.nextOfType("conversation:unread")).toEqual({ type: "conversation:unread", conversationId, unreadCount: 0 });
    await expect(aliceQ.nextOfType("message:status", 300)).rejects.toThrow(/Timed out/);

    sockets[2]!.send(JSON.stringify({ type: "message:read", conversationId, upToMessageId: messageId }));
    expect(await aliceQ.nextOfType("message:status")).toEqual({
      type: "message:status",
      conversationId,
      messageIds: [messageId],
      status: "read",
    });
  });

  it("refuses a client-sent read event for a conversation the user is not in", async () => {
    const { conversationId } = await createGroup(app, alice, [bob]);
    const sent = await sendMessage(app, alice, conversationId, { body: "private" });
    const eveQ = await open(eve);
    await delay(50);

    sockets[0]!.send(JSON.stringify({ type: "message:read", conversationId, upToMessageId: sent.body.message.id }));
    expect(await eveQ.nextOfType("error")).toMatchObject({ type: "error" });

    const receipts = await container.db.query("SELECT * FROM message_receipts WHERE user_id = $1", [eve.userId]);
    expect(receipts.rows).toEqual([]);
  });

  it("pushes membership changes to members, and stops delivering to removed members", async () => {
    const { groupId, conversationId } = await createGroup(app, alice, [bob]);
    const [aliceQ, bobQ, carolQ] = [await open(alice), await open(bob), await open(carol)];
    await delay(50);

    await request(app)
      .post(`/api/v1/groups/${groupId}/members`)
      .set("Authorization", `Bearer ${alice.accessToken}`)
      .send({ userIds: [carol.userId] });

    expect(await bobQ.nextOfType("group:member_added")).toMatchObject({ conversationId, userIds: [carol.userId], addedBy: alice.userId });
    expect(await carolQ.nextOfType("conversation:added")).toEqual({ type: "conversation:added", conversationId });

    await request(app)
      .patch(`/api/v1/groups/${groupId}/members/${bob.userId}/role`)
      .set("Authorization", `Bearer ${alice.accessToken}`)
      .send({ role: "admin" });
    expect(await carolQ.nextOfType("group:role_changed")).toMatchObject({ userId: bob.userId, role: "admin" });

    await request(app)
      .delete(`/api/v1/groups/${groupId}/members/${carol.userId}`)
      .set("Authorization", `Bearer ${bob.accessToken}`);
    expect(await aliceQ.nextOfType("group:member_removed")).toMatchObject({ userId: carol.userId, removedBy: bob.userId });
    expect(await carolQ.nextOfType("conversation:removed")).toEqual({ type: "conversation:removed", conversationId, reason: "removed" });

    await sendMessage(app, alice, conversationId, { body: "after carol left" });
    expect(await bobQ.nextOfType("message:new")).toMatchObject({ message: { body: "after carol left" } });
    await expect(carolQ.nextOfType("message:new", 300)).rejects.toThrow(/Timed out/);

    await request(app).post(`/api/v1/groups/${groupId}/leave`).set("Authorization", `Bearer ${bob.accessToken}`);
    expect(await aliceQ.nextOfType("group:member_left")).toMatchObject({ userId: bob.userId, newOwnerId: null });
  });

  it("pushes edits and deletions to members", async () => {
    const { conversationId } = await createGroup(app, alice, [bob]);
    const bobQ = await open(bob);
    await delay(50);

    const sent = await sendMessage(app, alice, conversationId, { body: "draft" });
    const messageId = sent.body.message.id as string;
    await bobQ.nextOfType("message:new");

    await request(app)
      .patch(`/api/v1/messages/${conversationId}/${messageId}`)
      .set("Authorization", `Bearer ${alice.accessToken}`)
      .send({ body: "final" });
    expect(await bobQ.nextOfType("message:updated")).toMatchObject({ message: { id: messageId, body: "final" } });

    await request(app)
      .delete(`/api/v1/messages/${conversationId}/${messageId}`)
      .set("Authorization", `Bearer ${alice.accessToken}`);
    expect(await bobQ.nextOfType("message:deleted")).toEqual({ type: "message:deleted", conversationId, messageId });
  });
});
