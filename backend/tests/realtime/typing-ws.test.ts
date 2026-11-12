import type { Express } from "express";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import type { WebSocket } from "ws";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import type { Container } from "../../src/container";
import { buildGatewayOptions } from "../../src/realtime/gateway-handlers";
import { attachWebSocketGateway, WS_PATH } from "../../src/realtime/ws.server";
import { as } from "../helpers/api";
import { createDirectConversation, createGroup } from "../helpers/fixtures";
import { createTestDb } from "../helpers/testDb";
import { signupTestUser, type TestUser } from "../helpers/testUser";
import { connect, createMessageQueue, delay } from "../helpers/wsClient";
import { TYPING_REFRESH_MS } from "../../src/modules/messages/messages.service";

describe("Typing indicator over WebSocket", () => {
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
    container.realtimeGatewayRef.current = attachWebSocketGateway(httpServer, buildGatewayOptions(container));
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
    await container.realtimeGatewayRef.current?.close?.();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  async function open(user: TestUser) {
    const socket = await connect(baseWsUrl, user.accessToken);
    sockets.push(socket);
    return { socket, queue: createMessageQueue(socket) };
  }

  const typing = (conversationId: string, isTyping: boolean) => JSON.stringify({ type: "typing", conversationId, isTyping });

  /** Resolves to the typing events received within `ms`. */
  async function typingEventsWithin(queue: ReturnType<typeof createMessageQueue>, ms: number) {
    const events: Record<string, unknown>[] = [];
    const deadline = Date.now() + ms;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return events;
      try {
        const event = await queue.next(remaining);
        if (event.type === "typing") events.push(event);
      } catch {
        return events;
      }
    }
  }

  it("relays start and stop to the other group members only — not the typist, not outsiders", async () => {
    const { conversationId } = await createGroup(app, alice, [bob, carol]);
    const a = await open(alice);
    const b = await open(bob);
    const c = await open(carol);
    const e = await open(eve);

    a.socket.send(typing(conversationId, true));
    expect(await b.queue.nextOfType("typing")).toEqual({ type: "typing", conversationId, userId: alice.userId, isTyping: true });
    expect(await c.queue.nextOfType("typing")).toMatchObject({ userId: alice.userId, isTyping: true });

    a.socket.send(typing(conversationId, false));
    expect(await b.queue.nextOfType("typing")).toMatchObject({ userId: alice.userId, isTyping: false });

    expect(await typingEventsWithin(a.queue, 300)).toEqual([]);
    expect(await typingEventsWithin(e.queue, 100)).toEqual([]);
  });

  it("ignores typing events from someone who isn't a member, and malformed payloads", async () => {
    const conversationId = await createDirectConversation(app, alice, bob);
    const b = await open(bob);
    const e = await open(eve);

    e.socket.send(typing(conversationId, true));
    e.socket.send(JSON.stringify({ type: "typing", conversationId: "not-a-uuid", isTyping: true }));
    e.socket.send(JSON.stringify({ type: "typing", conversationId, isTyping: "yes" }));

    expect(await typingEventsWithin(b.queue, 400)).toEqual([]);
    // No error frame either: nothing to learn about a conversation you're not in.
    expect(await typingEventsWithin(e.queue, 100)).toEqual([]);
  });

  it("throttles repeated starts but always relays a stop", async () => {
    const conversationId = await createDirectConversation(app, alice, bob);
    const a = await open(alice);
    const b = await open(bob);

    for (let i = 0; i < 10; i++) a.socket.send(typing(conversationId, true));
    a.socket.send(typing(conversationId, false));
    a.socket.send(typing(conversationId, true)); // a new burst after a stop is relayed straight away

    const received = await typingEventsWithin(b.queue, 500);
    expect(received.map((ev) => ev.isTyping)).toEqual([true, false, true]);

    await delay(TYPING_REFRESH_MS + 50);
    a.socket.send(typing(conversationId, true)); // still typing after the window → refreshed
    expect(await b.queue.nextOfType("typing")).toMatchObject({ isTyping: true });
  });

  it("stops relaying once the typist has left the group", async () => {
    const { groupId, conversationId } = await createGroup(app, alice, [bob]);
    const a = await open(alice);
    const b = await open(bob);
    expect((await as(app, bob).post(`/api/v1/groups/${groupId}/leave`)).status).toBe(200);

    b.socket.send(typing(conversationId, true));
    expect(await typingEventsWithin(a.queue, 400)).toEqual([]);
  });
});
