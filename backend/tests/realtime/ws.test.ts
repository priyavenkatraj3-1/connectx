import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import request from "supertest";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import type { Container } from "../../src/container";
import { attachWebSocketGateway, WS_PATH } from "../../src/realtime/ws.server";
import { createTestDb } from "../helpers/testDb";
import { signupTestUser, type TestUser } from "../helpers/testUser";
import type { Express } from "express";

/**
 * Queues every incoming message on a socket so tests can `.next()` them in
 * order, even if two frames arrive back-to-back before the test asks for
 * the second one — a plain sequential pair of `ws.once('message', ...)`
 * calls can lose the second frame if it arrives before the second
 * listener is attached.
 */
function createMessageQueue(ws: WebSocket) {
  const buffered: Record<string, unknown>[] = [];
  const waiters: Array<(msg: Record<string, unknown>) => void> = [];

  ws.on("message", (data) => {
    const parsed = JSON.parse(data.toString()) as Record<string, unknown>;
    const waiter = waiters.shift();
    if (waiter) {
      waiter(parsed);
    } else {
      buffered.push(parsed);
    }
  });

  return {
    next(): Promise<Record<string, unknown>> {
      const queued = buffered.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

function connect(baseWsUrl: string, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${baseWsUrl}?token=${token}`);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Realtime messaging over WebSocket", () => {
  let httpServer: Server;
  let baseWsUrl: string;
  let app: Express;
  let alice: TestUser;
  let bob: TestUser;
  let conversationId: string;
  let sockets: WebSocket[] = [];

  beforeEach(async () => {
    const db = await createTestDb();
    const created = createApp({ db });
    app = created.app;
    const container: Container = created.container;

    httpServer = createServer(app);
    const gateway = attachWebSocketGateway(httpServer, {
      onClientRead: (userId, convId, upToMessageId) => container.messagesService.markRead(convId, userId, upToMessageId),
    });
    container.realtimeGatewayRef.current = gateway;

    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const port = (httpServer.address() as AddressInfo).port;
    baseWsUrl = `ws://127.0.0.1:${port}${WS_PATH}`;

    alice = await signupTestUser(app, { displayName: "Alice" });
    bob = await signupTestUser(app, { displayName: "Bob" });

    const convRes = await request(app)
      .post("/api/v1/conversations/direct")
      .set("Authorization", `Bearer ${alice.accessToken}`)
      .send({ userId: bob.userId });
    conversationId = convRes.body.conversation.id as string;
  });

  afterEach(async () => {
    for (const socket of sockets) socket.close();
    sockets = [];
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it("rejects a connection with no valid access token before the handshake completes", async () => {
    await expect(
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`${baseWsUrl}?token=not-a-real-token`);
        ws.once("open", () => reject(new Error("should not have connected")));
        ws.once("error", (err) => resolve(err));
        ws.once("unexpected-response", (_req, res) => resolve(res.statusCode));
      })
    ).resolves.toBeDefined();
  });

  it("delivers a message to the recipient in real time and confirms delivery to the sender", async () => {
    const aliceSocket = await connect(baseWsUrl, alice.accessToken);
    const bobSocket = await connect(baseWsUrl, bob.accessToken);
    sockets.push(aliceSocket, bobSocket);
    await delay(50); // let both connections finish registering server-side

    const aliceQueue = createMessageQueue(aliceSocket);
    const bobQueue = createMessageQueue(bobSocket);

    const sendRes = await request(app)
      .post(`/api/v1/messages/${conversationId}`)
      .set("Authorization", `Bearer ${alice.accessToken}`)
      .send({ body: "Hi Bob, live!" });
    expect(sendRes.status).toBe(201);

    const bobEvent = await bobQueue.next();
    expect(bobEvent).toMatchObject({
      type: "message:new",
      conversationId,
      message: { body: "Hi Bob, live!", senderId: alice.userId },
    });

    const aliceDeliveredEvent = await aliceQueue.next();
    expect(aliceDeliveredEvent).toMatchObject({ type: "message:delivered", conversationId, userId: bob.userId });
  });

  it("notifies the sender in real time when the recipient reads the message", async () => {
    const aliceSocket = await connect(baseWsUrl, alice.accessToken);
    const bobSocket = await connect(baseWsUrl, bob.accessToken);
    sockets.push(aliceSocket, bobSocket);
    await delay(50);

    const aliceQueue = createMessageQueue(aliceSocket);
    const bobQueue = createMessageQueue(bobSocket);

    const sendRes = await request(app)
      .post(`/api/v1/messages/${conversationId}`)
      .set("Authorization", `Bearer ${alice.accessToken}`)
      .send({ body: "Did you see this?" });
    const messageId = sendRes.body.message.id as string;

    await bobQueue.next(); // message:new
    await aliceQueue.next(); // message:delivered
    await aliceQueue.next(); // message:new echo

    bobSocket.send(JSON.stringify({ type: "message:read", conversationId, upToMessageId: messageId }));

    const event = await aliceQueue.next();
    expect(event).toEqual({ type: "message:read", conversationId, userId: bob.userId, upToMessageId: messageId });
  });
});
