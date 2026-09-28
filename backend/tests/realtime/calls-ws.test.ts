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

describe("Call signaling over WebSocket", () => {
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
    ({ app, container } = createApp({ db, callReconnectGraceMs: 100 }));
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
    await delay(20);
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

  function send(ws: WebSocket, event: Record<string, unknown>) {
    ws.send(JSON.stringify(event));
  }

  async function startCall(user: TestUser, conversationId: string, connectionId: string, media = "video") {
    const res = await request(app)
      .post("/api/v1/calls")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ conversationId, media, connectionId });
    expect(res.status).toBe(201);
    return res.body.call.id as string;
  }

  it("runs a full 1:1 call: invite → ring → accept → offer/answer/ICE relayed to the joined devices only → end", async () => {
    const conversationId = await createDirectConversation(app, alice, bob);
    const aliceTab = await open(alice);
    const bobPhone = await open(bob);
    const bobLaptop = await open(bob);
    const eveTab = await open(eve);
    await delay(30);

    const callId = await startCall(alice, conversationId, aliceTab.cid);

    // Both of Bob's devices ring.
    for (const device of [bobPhone, bobLaptop]) {
      expect(await device.q.nextOfType("call:invite")).toMatchObject({ call: { id: callId, media: "video", state: "ringing" } });
    }
    send(bobPhone.ws, { type: "call:ring", callId });
    expect(await aliceTab.q.nextOfType("call:ring")).toEqual({ type: "call:ring", callId, userId: bob.userId });

    // Bob answers on his phone; his laptop is told so it can stop ringing.
    send(bobPhone.ws, { type: "call:accept", callId });
    expect(await aliceTab.q.nextOfType("call:accept")).toMatchObject({ userId: bob.userId, call: { state: "accepted" } });
    expect(await bobLaptop.q.nextOfType("call:accept")).toMatchObject({ userId: bob.userId });

    // The joiner (Bob) offers; only Alice's tab gets it.
    send(bobPhone.ws, { type: "call:offer", callId, toUserId: alice.userId, sdp: "v=0 offer-sdp" });
    expect(await aliceTab.q.nextOfType("call:offer")).toEqual({
      type: "call:offer",
      callId,
      fromUserId: bob.userId,
      sdp: "v=0 offer-sdp",
    });

    send(aliceTab.ws, { type: "call:answer", callId, toUserId: bob.userId, sdp: "v=0 answer-sdp" });
    expect(await bobPhone.q.nextOfType("call:answer")).toMatchObject({ fromUserId: alice.userId, sdp: "v=0 answer-sdp" });

    const candidate = { candidate: "candidate:1 1 udp 2122260223 192.168.1.2 50000 typ host", sdpMid: "0", sdpMLineIndex: 0 };
    send(aliceTab.ws, { type: "call:ice_candidate", callId, toUserId: bob.userId, candidate });
    expect(await bobPhone.q.nextOfType("call:ice_candidate")).toMatchObject({ fromUserId: alice.userId, candidate });

    send(bobPhone.ws, { type: "call:connected", callId });
    expect(await aliceTab.q.nextOfType("call:updated")).toMatchObject({ call: { state: "connected" } });

    send(aliceTab.ws, { type: "call:end", callId });
    expect(await bobPhone.q.nextOfType("call:end")).toMatchObject({ userId: alice.userId, call: { state: "ended" } });

    // Signaling never reached Bob's other device or the outsider.
    await expect(bobLaptop.q.nextOfType("call:offer", 200)).rejects.toThrow();
    await expect(bobLaptop.q.nextOfType("call:answer", 50)).rejects.toThrow();
    await expect(eveTab.q.nextOfType("call:invite", 50)).rejects.toThrow();
  });

  it("rejects signaling from an unauthorized user without relaying anything", async () => {
    const conversationId = await createDirectConversation(app, alice, carol);
    const aliceTab = await open(alice);
    const carolTab = await open(carol);
    const eveTab = await open(eve);
    await delay(30);

    const callId = await startCall(alice, conversationId, aliceTab.cid, "voice");
    await carolTab.q.nextOfType("call:invite");
    send(carolTab.ws, { type: "call:accept", callId });
    await aliceTab.q.nextOfType("call:accept");

    // Eve tries to inject an offer and to hang the call up.
    send(eveTab.ws, { type: "call:offer", callId, toUserId: alice.userId, sdp: "v=0 evil" });
    expect(await eveTab.q.nextOfType("call:error")).toMatchObject({ callId, message: expect.stringMatching(/not in this call/) });
    send(eveTab.ws, { type: "call:end", callId });
    expect(await eveTab.q.nextOfType("call:error")).toMatchObject({ callId, message: expect.stringMatching(/not part of this call/) });
    await expect(aliceTab.q.nextOfType("call:offer", 200)).rejects.toThrow();

    send(aliceTab.ws, { type: "call:end", callId });
    await carolTab.q.nextOfType("call:end");
  });

  it("answers malformed signaling with call:error and keeps the connection usable", async () => {
    const { q, ws } = await open(alice);
    await delay(30);

    send(ws, { type: "call:offer", callId: "not-a-uuid", toUserId: bob.userId, sdp: "v=0" });
    expect(await q.nextOfType("call:error")).toEqual({ type: "call:error", callId: null, message: "Malformed call:offer event" });

    const callId = randomUUID();
    send(ws, { type: "call:ice_candidate", callId, toUserId: bob.userId, candidate: { candidate: 42 } });
    expect(await q.nextOfType("call:error")).toMatchObject({ callId, message: "Malformed call:ice_candidate event" });

    // Well-formed but for a call that doesn't exist.
    send(ws, { type: "call:accept", callId });
    expect(await q.nextOfType("call:error")).toMatchObject({ callId, message: "Call not found" });

    ws.send("}{ not json");
    send(ws, { type: "call:accept", callId });
    expect(await q.nextOfType("call:error")).toMatchObject({ callId });
  });

  it("closes connections that send oversized frames", async () => {
    const { ws } = await open(alice);
    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
    ws.send("x".repeat(200 * 1024));
    expect(await closed).toBe(1009); // "message too big"
  });

  it("ends the call if the joined device disconnects and doesn't come back", async () => {
    const conversationId = await createDirectConversation(app, bob, carol);
    const bobTab = await open(bob);
    const carolTab = await open(carol);
    await delay(30);

    const callId = await startCall(bob, conversationId, bobTab.cid, "voice");
    await carolTab.q.nextOfType("call:invite");
    send(carolTab.ws, { type: "call:accept", callId });
    await bobTab.q.nextOfType("call:accept");

    carolTab.ws.close();
    expect(await bobTab.q.nextOfType("call:end", 2000)).toMatchObject({
      userId: carol.userId,
      call: { state: "ended", endReason: "disconnected" },
    });
  });

  it("keeps the call when the same connection ID reconnects within the grace period", async () => {
    const conversationId = await createDirectConversation(app, alice, bob);
    const aliceTab = await open(alice);
    const bobTab = await open(bob);
    await delay(30);

    const callId = await startCall(alice, conversationId, aliceTab.cid, "voice");
    await bobTab.q.nextOfType("call:invite");
    send(bobTab.ws, { type: "call:accept", callId });
    await aliceTab.q.nextOfType("call:accept");

    bobTab.ws.close();
    await delay(20);
    const bobAgain = await open(bob, bobTab.cid);
    await delay(250);

    // Still live, and signaling reaches the reconnected socket.
    send(aliceTab.ws, { type: "call:offer", callId, toUserId: bob.userId, sdp: "v=0 after-reconnect" });
    expect(await bobAgain.q.nextOfType("call:offer")).toMatchObject({ sdp: "v=0 after-reconnect" });
    send(aliceTab.ws, { type: "call:end", callId });
    await bobAgain.q.nextOfType("call:end");
  });

  it("group call: a joiner's offers reach each joined member, and leaving notifies the rest", async () => {
    const { conversationId } = await createGroup(app, alice, [bob, carol]);
    const aliceTab = await open(alice);
    const bobTab = await open(bob);
    const carolTab = await open(carol);
    await delay(30);

    const callId = await startCall(alice, conversationId, aliceTab.cid);
    await bobTab.q.nextOfType("call:invite");
    await carolTab.q.nextOfType("call:invite");

    send(bobTab.ws, { type: "call:accept", callId });
    await aliceTab.q.nextOfType("call:accept");
    await bobTab.q.nextOfType("call:accept"); // Bob's own join
    send(carolTab.ws, { type: "call:accept", callId });
    const carolJoined = await bobTab.q.nextOfType("call:accept");
    expect(carolJoined).toMatchObject({ userId: carol.userId });

    // Mesh: Carol (the newest joiner) offers to both existing participants.
    send(carolTab.ws, { type: "call:offer", callId, toUserId: alice.userId, sdp: "v=0 c→a" });
    send(carolTab.ws, { type: "call:offer", callId, toUserId: bob.userId, sdp: "v=0 c→b" });
    expect(await aliceTab.q.nextOfType("call:offer")).toMatchObject({ fromUserId: carol.userId, sdp: "v=0 c→a" });
    expect(await bobTab.q.nextOfType("call:offer")).toMatchObject({ fromUserId: carol.userId, sdp: "v=0 c→b" });

    send(bobTab.ws, { type: "call:end", callId });
    expect(await aliceTab.q.nextOfType("call:participant_left")).toMatchObject({ userId: bob.userId });
    send(aliceTab.ws, { type: "call:end", callId });
    send(carolTab.ws, { type: "call:end", callId });
    expect(await carolTab.q.nextOfType("call:end")).toMatchObject({ call: { state: "ended" } });
  });
});
