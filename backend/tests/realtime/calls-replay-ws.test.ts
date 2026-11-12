import { randomUUID } from "crypto";
import type { Express } from "express";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import request from "supertest";
import type { WebSocket } from "ws";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import type { Container } from "../../src/container";
import { buildGatewayOptions } from "../../src/realtime/gateway-handlers";
import { attachWebSocketGateway, WS_PATH } from "../../src/realtime/ws.server";
import { createDirectConversation, createGroup } from "../helpers/fixtures";
import { createTestDb } from "../helpers/testDb";
import { signupTestUser, type TestUser } from "../helpers/testUser";
import { connect, createMessageQueue, delay } from "../helpers/wsClient";

type Queue = ReturnType<typeof createMessageQueue>;
const RING_TIMEOUT_MS = 1500;

describe("Replaying ringing call invites when a device (re)connects", () => {
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
    ({ app, container } = createApp({ db, callReconnectGraceMs: 100, callRingTimeoutMs: RING_TIMEOUT_MS }));
    httpServer = createServer(app);
    container.realtimeGatewayRef.current = attachWebSocketGateway(httpServer, buildGatewayOptions(container));
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    baseWsUrl = `ws://127.0.0.1:${(httpServer.address() as AddressInfo).port}${WS_PATH}`;
    alice = await signupTestUser(app, { displayName: "Alice" });
    bob = await signupTestUser(app, { displayName: "Bob" });
    carol = await signupTestUser(app, { displayName: "Carol" });
    eve = await signupTestUser(app, { displayName: "Eve" });
  });

  afterEach(async () => {
    for (const socket of sockets) socket.close();
    sockets = [];
    await delay(150); // past the reconnect grace, so calls from one test don't linger into the next
  });

  afterAll(async () => {
    container.callsService.dispose();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  async function open(user: TestUser, cid = randomUUID()): Promise<{ q: Queue; ws: WebSocket; cid: string }> {
    const ws = await connect(baseWsUrl, user.accessToken, cid);
    sockets.push(ws);
    return { q: createMessageQueue(ws), ws, cid };
  }

  async function startCall(user: TestUser, conversationId: string, connectionId: string) {
    const res = await request(app)
      .post("/api/v1/calls")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ conversationId, media: "voice", connectionId });
    expect(res.status).toBe(201);
    return res.body.call.id as string;
  }

  async function endCall(user: TestUser, callId: string) {
    await request(app).post(`/api/v1/calls/${callId}/end`).set("Authorization", `Bearer ${user.accessToken}`);
  }

  /** Invites received within `ms` (none expected → resolves to []). */
  async function invitesWithin(q: Queue, ms: number): Promise<Array<Record<string, unknown>>> {
    const invites: Array<Record<string, unknown>> = [];
    const deadline = Date.now() + ms;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return invites;
      try {
        const event = await q.next(remaining);
        if (event.type === "call:invite") invites.push(event);
      } catch {
        return invites;
      }
    }
  }

  it("rings a callee who connects while the call is still ringing, on that device only", async () => {
    const conversationId = await createDirectConversation(app, alice, bob);
    const aliceTab = await open(alice);
    const callId = await startCall(alice, conversationId, aliceTab.cid); // Bob is offline: the original invite reaches nobody

    const bobPhone = await open(bob);
    const invite = await bobPhone.q.nextOfType("call:invite");
    expect(invite).toMatchObject({ type: "call:invite", call: { id: callId, conversationId, initiatorId: alice.userId, state: "ringing" } });

    // The device acknowledges as usual, and the caller sees "Ringing…".
    bobPhone.ws.send(JSON.stringify({ type: "call:ring", callId }));
    expect(await aliceTab.q.nextOfType("call:ring")).toMatchObject({ callId });

    // Another device connecting gets its own copy; the already-connected one isn't sent a duplicate.
    const bobLaptop = await open(bob);
    expect((await bobLaptop.q.nextOfType("call:invite")).call).toMatchObject({ id: callId });
    expect(await invitesWithin(bobPhone.q, 200)).toEqual([]);

    await endCall(alice, callId);
  });

  it("doesn't replay once the call was answered, declined or cancelled", async () => {
    const conversationId = await createDirectConversation(app, alice, bob);
    const aliceTab = await open(alice);

    // Cancelled by the caller before Bob came online.
    const cancelled = await startCall(alice, conversationId, aliceTab.cid);
    aliceTab.ws.send(JSON.stringify({ type: "call:cancel", callId: cancelled }));
    await aliceTab.q.nextOfType("call:cancel");
    expect(await invitesWithin((await open(bob)).q, 400)).toEqual([]);

    // Declined on Bob's phone → his laptop, connecting later, doesn't ring.
    const declined = await startCall(alice, conversationId, aliceTab.cid);
    const bobPhone = await open(bob);
    await bobPhone.q.nextOfType("call:invite");
    bobPhone.ws.send(JSON.stringify({ type: "call:decline", callId: declined }));
    await aliceTab.q.nextOfType("call:decline");
    expect(await invitesWithin((await open(bob)).q, 400)).toEqual([]);
  });

  it("never replays an invite whose ring timeout has passed (it's a missed call)", async () => {
    const conversationId = await createDirectConversation(app, alice, carol);
    const aliceTab = await open(alice);
    const callId = await startCall(alice, conversationId, aliceTab.cid);

    await delay(RING_TIMEOUT_MS + 300);
    const call = await request(app).get(`/api/v1/calls/${callId}`).set("Authorization", `Bearer ${alice.accessToken}`);
    expect(call.body.call.state).toBe("missed");
    expect(await invitesWithin((await open(carol)).q, 400)).toEqual([]);
  });

  it("only invitees get it — not the caller's other devices or outsiders", async () => {
    const conversationId = await createDirectConversation(app, alice, bob);
    const aliceTab = await open(alice);
    const callId = await startCall(alice, conversationId, aliceTab.cid);

    expect(await invitesWithin((await open(eve)).q, 300)).toEqual([]);
    expect(await invitesWithin((await open(alice)).q, 300)).toEqual([]);
    await endCall(alice, callId);
  });

  it("doesn't ring someone who is already in another call", async () => {
    // Bob is in a call with Carol…
    const bobCarol = await createDirectConversation(app, carol, bob);
    const carolTab = await open(carol);
    const bobTab = await open(bob);
    const busyCall = await startCall(carol, bobCarol, carolTab.cid);
    await bobTab.q.nextOfType("call:invite");
    bobTab.ws.send(JSON.stringify({ type: "call:accept", callId: busyCall }));
    await carolTab.q.nextOfType("call:accept");

    // …when Alice starts a group call that includes him; a new device of his connects.
    const { conversationId: group } = await createGroup(app, alice, [bob]);
    const aliceTab = await open(alice);
    const groupCall = await startCall(alice, group, aliceTab.cid);
    expect(await invitesWithin((await open(bob)).q, 400)).toEqual([]);

    await endCall(alice, groupCall);
    await endCall(carol, busyCall);
  });
});
