import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import type { Express } from "express";
import request from "supertest";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import type { Container } from "../../src/container";
import { buildGatewayOptions } from "../../src/realtime/gateway-handlers";
import {
  attachWebSocketGateway,
  RATE_LIMITED_CLOSE_CODE,
  WS_PATH,
  type WebSocketGateway,
  type WebSocketGatewayOptions,
} from "../../src/realtime/ws.server";
import { createDirectConversation, sendMessage } from "../helpers/fixtures";
import { createTestDb } from "../helpers/testDb";
import { signupTestUser, type TestUser } from "../helpers/testUser";
import { connect, createMessageQueue, delay } from "../helpers/wsClient";

/** Resolves with the HTTP status the server answered the upgrade with, or "open" if the socket opened. */
function handshakeResult(url: string, headers: Record<string, string> = {}): Promise<number | "open"> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.once("open", () => {
      ws.close();
      resolve("open");
    });
    ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    ws.once("error", (err) => {
      if (!/Unexpected server response/.test(String(err))) reject(err);
    });
  });
}

function waitForClose(ws: WebSocket, timeoutMs = 3000): Promise<number> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === ws.CLOSED) return resolve(-1);
    const timer = setTimeout(() => reject(new Error("socket did not close")), timeoutMs);
    ws.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

/**
 * Phase 7: WebSocket gateway abuse and lifecycle behavior — handshake
 * authentication and Origin checks, per-user connection caps, inbound
 * flood protection, heartbeat cleanup of dead connections, malformed
 * frames, and graceful close.
 */
describe("WebSocket gateway security (Phase 7)", () => {
  let httpServer: Server;
  let app: Express;
  let container: Container;
  let gateway: WebSocketGateway;
  let baseWsUrl: string;
  let alice: TestUser;
  let bob: TestUser;
  let sockets: WebSocket[] = [];

  async function start(overrides: Partial<WebSocketGatewayOptions> = {}): Promise<void> {
    httpServer = createServer(app);
    gateway = attachWebSocketGateway(httpServer, { ...buildGatewayOptions(container), ...overrides });
    container.realtimeGatewayRef.current = gateway;
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    baseWsUrl = `ws://127.0.0.1:${(httpServer.address() as AddressInfo).port}${WS_PATH}`;
  }

  async function open(user: TestUser, cid?: string): Promise<WebSocket> {
    const ws = await connect(baseWsUrl, user.accessToken, cid);
    sockets.push(ws);
    return ws;
  }

  beforeEach(async () => {
    ({ app, container } = createApp({ db: await createTestDb() }));
    alice = await signupTestUser(app, { displayName: "Alice WS" });
    bob = await signupTestUser(app, { displayName: "Bob WS" });
  });

  afterEach(async () => {
    for (const socket of sockets) socket.terminate();
    sockets = [];
    await gateway.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it("rejects handshakes without a valid, active session token", async () => {
    await start();
    expect(await handshakeResult(baseWsUrl)).toBe(401);
    expect(await handshakeResult(`${baseWsUrl}?token=garbage`)).toBe(401);

    // A token whose session was signed out is refused at the handshake.
    const login = await request(app).post("/api/v1/auth/login").send({ email: alice.email, password: "Passw0rd!" });
    const token = login.body.tokens.accessToken as string;
    expect(await handshakeResult(`${baseWsUrl}?token=${token}`)).toBe("open");
    await request(app).post("/api/v1/auth/logout").set("Authorization", `Bearer ${token}`);
    expect(await handshakeResult(`${baseWsUrl}?token=${token}`)).toBe(401);
  });

  it("refuses browser handshakes from origins that aren't allowed", async () => {
    await start({ allowedOrigins: ["http://app.example"] });
    const url = `${baseWsUrl}?token=${alice.accessToken}`;
    expect(await handshakeResult(url, { Origin: "http://evil.example" })).toBe(403);
    expect(await handshakeResult(url, { Origin: "http://app.example" })).toBe("open");
    // Non-browser clients send no Origin and are judged by their token alone.
    expect(await handshakeResult(url)).toBe("open");
  });

  it("caps concurrent connections per user, but always allows a reconnect of the same connection", async () => {
    await start({ maxConnectionsPerUser: 2 });
    const cid = "11111111-1111-4111-8111-111111111111";
    await open(alice, cid);
    await open(alice);
    expect(await handshakeResult(`${baseWsUrl}?token=${alice.accessToken}`)).toBe(429);
    // Same connection ID = a reconnect replacing its own earlier socket.
    expect(await handshakeResult(`${baseWsUrl}?token=${alice.accessToken}&cid=${cid}`)).toBe("open");
    // Other users are unaffected.
    expect(await handshakeResult(`${baseWsUrl}?token=${bob.accessToken}`)).toBe("open");
  });

  it("closes a connection that floods the server with frames", async () => {
    await start({ maxMessagesPer10s: 20 });
    const ws = await open(alice);
    const closed = waitForClose(ws);
    for (let i = 0; i < 40; i += 1) ws.send(JSON.stringify({ type: "ping" }));
    expect(await closed).toBe(RATE_LIMITED_CLOSE_CODE);
    // The user can reconnect afterwards.
    await open(alice);
  });

  it("terminates connections that stop answering heartbeats", async () => {
    await start({ heartbeatIntervalMs: 60 });
    const silent = new WebSocket(`${baseWsUrl}?token=${alice.accessToken}`, { autoPong: false });
    sockets.push(silent);
    await new Promise((resolve) => silent.once("open", resolve));
    const healthy = await open(bob);

    await waitForClose(silent, 2000);
    // Its registry entry is removed (server-side close handling can land a tick after the client sees the close)...
    for (let i = 0; i < 20 && gateway.isUserOnline(alice.userId); i += 1) await delay(25);
    expect(gateway.isUserOnline(alice.userId)).toBe(false);
    // ...while a responsive client stays connected.
    await delay(200);
    expect(healthy.readyState).toBe(healthy.OPEN);
    expect(gateway.isUserOnline(bob.userId)).toBe(true);
  });

  it("survives malformed and unauthorized frames without leaking anything", async () => {
    await start();
    const conversationId = await createDirectConversation(app, alice, bob);
    const sent = await sendMessage(app, alice, conversationId, { body: "hello" });
    const messageId = sent.body.message.id as string;
    const carol = await signupTestUser(app, { displayName: "Carol WS" });

    const carolSocket = await open(carol);
    const carolEvents = createMessageQueue(carolSocket);
    const bobSocket = await open(bob);
    const bobEvents = createMessageQueue(bobSocket);

    // Garbage of every shape: none of it may crash the server or close the socket.
    for (const frame of [
      "not json",
      "{}",
      "[]",
      "null",
      JSON.stringify({ type: 42 }),
      JSON.stringify({ type: "message:read" }),
      JSON.stringify({ type: "message:read", conversationId: "nope", upToMessageId: "nope" }),
      JSON.stringify({ type: "unknown:event", data: "x" }),
      JSON.stringify({ type: "call:offer", callId: "not-a-uuid", toUserId: bob.userId, sdp: "x" }),
      JSON.stringify({ type: "__proto__", polluted: true }),
    ]) {
      carolSocket.send(frame);
    }
    const callError = await carolEvents.nextOfType("call:error");
    expect(callError.callId).toBeNull();

    // Carol marking Alice/Bob's conversation read is refused and tells nobody anything.
    carolSocket.send(JSON.stringify({ type: "message:read", conversationId, upToMessageId: messageId }));
    const error = await carolEvents.nextOfType("error");
    expect(error.message).toBe("Failed to process message");
    await expect(bobEvents.nextOfType("message:read", 300)).rejects.toThrow();

    // Signaling a call that doesn't exist is rejected with a generic call:error.
    carolSocket.send(
      JSON.stringify({ type: "call:offer", callId: "22222222-2222-4222-8222-222222222222", toUserId: bob.userId, sdp: "v=0" })
    );
    const offerError = await carolEvents.nextOfType("call:error");
    expect(offerError.callId).toBe("22222222-2222-4222-8222-222222222222");
    await expect(bobEvents.nextOfType("call:offer", 300)).rejects.toThrow();

    expect(carolSocket.readyState).toBe(carolSocket.OPEN);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("drops frames larger than the payload limit by closing that connection only", async () => {
    await start();
    const big = await open(alice);
    const other = await open(bob);
    const closed = waitForClose(big);
    big.send("x".repeat(200 * 1024));
    expect(await closed).toBe(1009); // "message too big"
    expect(other.readyState).toBe(other.OPEN);
  });

  it("close() disconnects every client with 1001 so they reconnect elsewhere", async () => {
    await start();
    const ws = await open(alice);
    const closed = waitForClose(ws);
    await gateway.close();
    expect(await closed).toBe(1001);
  });
});
