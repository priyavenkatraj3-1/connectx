import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import type { Express } from "express";
import request from "supertest";
import type { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import type { Container } from "../../src/container";
import { signAccessToken } from "../../src/modules/auth/token.service";
import { buildGatewayOptions } from "../../src/realtime/gateway-handlers";
import { attachWebSocketGateway, SESSION_REVOKED_CLOSE_CODE, WS_PATH } from "../../src/realtime/ws.server";
import { as } from "../helpers/api";
import { createTestDb } from "../helpers/testDb";
import { signupTestUser, type TestUser } from "../helpers/testUser";
import { connect, createMessageQueue } from "../helpers/wsClient";

const PASSWORD = "Passw0rd!";

async function login(app: Express, user: TestUser, device?: { name?: string; platform?: string }, userAgent?: string) {
  const req = request(app).post("/api/v1/auth/login");
  if (userAgent) req.set("User-Agent", userAgent);
  const res = await req.send({ email: user.email, password: PASSWORD, ...(device ? { device } : {}) });
  expect(res.status).toBe(200);
  return res.body as { tokens: { accessToken: string; refreshToken: string }; session: { id: string } };
}

describe("Multi-device sessions (Phase 6)", () => {
  let app: Express;
  let container: Container;
  let alice: TestUser;
  let bob: TestUser;

  beforeEach(async () => {
    ({ app, container } = createApp({ db: await createTestDb() }));
    alice = await signupTestUser(app, { displayName: "Alice" });
    bob = await signupTestUser(app, { displayName: "Bob" });
  });

  it("registers a device/session on every sign-in and lists them without secrets", async () => {
    const laptop = await login(
      app,
      alice,
      undefined,
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
    );
    await login(app, alice, { name: "Alice's phone", platform: "android" });

    const res = await request(app).get("/api/v1/sessions").set("Authorization", `Bearer ${laptop.tokens.accessToken}`);
    expect(res.status).toBe(200);
    const sessions = res.body.sessions as Array<Record<string, unknown>>;
    expect(sessions).toHaveLength(3); // signup + two logins
    const current = sessions.find((s) => s.current);
    expect(current).toMatchObject({ id: laptop.session.id, deviceName: "Chrome on Windows", userAgentSummary: "Chrome on Windows" });
    expect(sessions.find((s) => s.deviceName === "Alice's phone")).toMatchObject({ platform: "android", current: false });

    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain(laptop.tokens.refreshToken);
    expect(raw).not.toMatch(/refresh_token_hash|refreshTokenHash/);
  });

  it("notifies the user about a new sign-in", async () => {
    await login(app, alice, { name: "New laptop" });
    const res = await as(app, alice).get("/api/v1/notifications");
    expect(res.body.notifications[0]).toMatchObject({ type: "session_new", title: "New sign-in to your account" });
  });

  it("revoking a session invalidates its access token immediately, but not other sessions", async () => {
    const phone = await login(app, alice, { name: "Phone" });
    const revoke = await as(app, alice).delete(`/api/v1/sessions/${phone.session.id}`);
    expect(revoke.status).toBe(204);

    const denied = await request(app).get("/api/v1/tasks").set("Authorization", `Bearer ${phone.tokens.accessToken}`);
    expect(denied.status).toBe(401);
    expect(denied.body.error.code).toBe("session_revoked");
    expect((await as(app, alice).get("/api/v1/tasks")).status).toBe(200);

    const refresh = await request(app).post("/api/v1/auth/refresh").send({ refreshToken: phone.tokens.refreshToken });
    expect(refresh.status).toBe(401);
  });

  it("users can't see or revoke other users' sessions", async () => {
    const bobs = await login(app, bob);
    expect((await as(app, alice).delete(`/api/v1/sessions/${bobs.session.id}`)).status).toBe(404);
    expect((await as(app, alice).patch(`/api/v1/sessions/${bobs.session.id}`).send({ deviceName: "pwned" })).status).toBe(404);
    const aliceView = await as(app, alice).get("/api/v1/sessions");
    expect(aliceView.body.sessions.some((s: { id: string }) => s.id === bobs.session.id)).toBe(false);
    const stillWorks = await request(app).get("/api/v1/tasks").set("Authorization", `Bearer ${bobs.tokens.accessToken}`);
    expect(stillWorks.status).toBe(200);
  });

  it("renames a device and signs out all other devices", async () => {
    const phone = await login(app, alice, { name: "Phone" });
    const tablet = await login(app, alice, { name: "Tablet" });
    const renamed = await as(app, alice).patch(`/api/v1/sessions/${phone.session.id}`).send({ deviceName: "Work phone" });
    expect(renamed.body.sessions.some((s: { deviceName: string }) => s.deviceName === "Work phone")).toBe(true);

    const res = await as(app, alice).post("/api/v1/sessions/revoke-others");
    expect(res.body.revoked).toBe(2);
    for (const token of [phone.tokens.accessToken, tablet.tokens.accessToken]) {
      expect((await request(app).get("/api/v1/tasks").set("Authorization", `Bearer ${token}`)).status).toBe(401);
    }
    expect((await as(app, alice).get("/api/v1/sessions")).body.sessions).toHaveLength(1);
  });

  it("rotates refresh tokens and ends the session if an old one is reused", async () => {
    const phone = await login(app, alice);
    const first = await request(app).post("/api/v1/auth/refresh").send({ refreshToken: phone.tokens.refreshToken });
    expect(first.status).toBe(200);
    expect(first.body.session.id).toBe(phone.session.id);
    expect(first.body.tokens.refreshToken).not.toBe(phone.tokens.refreshToken);
    expect((await request(app).get("/api/v1/tasks").set("Authorization", `Bearer ${first.body.tokens.accessToken}`)).status).toBe(200);

    // Replaying the rotated-out token looks like theft: the whole session ends.
    const replay = await request(app).post("/api/v1/auth/refresh").send({ refreshToken: phone.tokens.refreshToken });
    expect(replay.status).toBe(401);
    expect((await request(app).get("/api/v1/tasks").set("Authorization", `Bearer ${first.body.tokens.accessToken}`)).status).toBe(401);
    expect((await request(app).post("/api/v1/auth/refresh").send({ refreshToken: "garbage" })).status).toBe(401);
  });

  it("logout ends only the current session and is idempotent", async () => {
    const phone = await login(app, alice);
    const out = await request(app).post("/api/v1/auth/logout").set("Authorization", `Bearer ${phone.tokens.accessToken}`);
    expect(out.status).toBe(204);
    expect((await request(app).get("/api/v1/tasks").set("Authorization", `Bearer ${phone.tokens.accessToken}`)).status).toBe(401);
    expect((await request(app).post("/api/v1/auth/logout").set("Authorization", `Bearer ${phone.tokens.accessToken}`)).status).toBe(204);
    expect((await as(app, alice).get("/api/v1/tasks")).status).toBe(200);
  });

  it("rejects access tokens that carry no session", async () => {
    const sessionless = signAccessToken({ userId: alice.userId });
    const res = await request(app).get("/api/v1/tasks").set("Authorization", `Bearer ${sessionless}`);
    expect(res.status).toBe(401);
  });

  describe("over WebSocket", () => {
    let httpServer: Server;
    let baseWsUrl: string;
    const sockets: WebSocket[] = [];

    beforeEach(async () => {
      httpServer = createServer(app);
      container.realtimeGatewayRef.current = attachWebSocketGateway(httpServer, buildGatewayOptions(container));
      await new Promise<void>((resolve) => httpServer.listen(0, resolve));
      baseWsUrl = `ws://127.0.0.1:${(httpServer.address() as AddressInfo).port}${WS_PATH}`;
    });

    afterEach(async () => {
      for (const socket of sockets.splice(0)) socket.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });

    it("tells the revoked device and closes only its connection", async () => {
      const phone = await login(app, alice, { name: "Phone" });
      const phoneSocket = await connect(baseWsUrl, phone.tokens.accessToken);
      const laptopSocket = await connect(baseWsUrl, alice.accessToken);
      sockets.push(phoneSocket, laptopSocket);
      const phoneEvents = createMessageQueue(phoneSocket);
      const laptopEvents = createMessageQueue(laptopSocket);
      const closed = new Promise<number>((resolve) => phoneSocket.once("close", (code) => resolve(code)));

      await as(app, alice).delete(`/api/v1/sessions/${phone.session.id}`);

      expect(await phoneEvents.nextOfType("session:revoked")).toMatchObject({ sessionId: phone.session.id });
      expect(await closed).toBe(SESSION_REVOKED_CLOSE_CODE);
      expect(await laptopEvents.nextOfType("sessions:updated")).toBeTruthy();
      expect(laptopSocket.readyState).toBe(laptopSocket.OPEN);

      // A revoked token can't open a new connection.
      await expect(connect(baseWsUrl, phone.tokens.accessToken)).rejects.toBeTruthy();
    });

    it("syncs productivity updates to every device of the user, and nobody else", async () => {
      const phone = await login(app, alice, { name: "Phone" });
      const phoneSocket = await connect(baseWsUrl, phone.tokens.accessToken);
      const bobSocket = await connect(baseWsUrl, bob.accessToken);
      sockets.push(phoneSocket, bobSocket);
      const phoneEvents = createMessageQueue(phoneSocket);
      const bobEvents = createMessageQueue(bobSocket);

      await as(app, alice).post("/api/v1/tasks").send({ title: "Synced" });
      const event = await phoneEvents.nextOfType("task:updated");
      expect((event.task as { title: string }).title).toBe("Synced");
      await expect(bobEvents.nextOfType("task:updated", 300)).rejects.toThrow();
    });
  });
});
