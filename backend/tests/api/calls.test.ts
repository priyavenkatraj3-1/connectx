import type { Express } from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import type { Container } from "../../src/container";
import type { CallDTO } from "../../src/modules/calls/calls.types";
import type { ConnectionContext } from "../../src/realtime/ws.server";
import { FakeRealtimeGateway } from "../helpers/fakeRealtimeGateway";
import { createGroup, createDirectConversation } from "../helpers/fixtures";
import { createTestDb } from "../helpers/testDb";
import { signupTestUser, type TestUser } from "../helpers/testUser";
import { delay } from "../helpers/wsClient";

function auth(user: TestUser) {
  return { Authorization: `Bearer ${user.accessToken}` };
}

// Long enough that calls left ringing don't time out mid-test when the full suite runs in parallel.
const RING_TIMEOUT_MS = 2000;

describe("Calls API and lifecycle", () => {
  let app: Express;
  let container: Container;
  let gateway: FakeRealtimeGateway;
  let alice: TestUser;
  let bob: TestUser;
  let carol: TestUser;
  let eve: TestUser;
  /** One connection ID per user, declared open in the fake gateway. */
  const cid: Record<string, string> = {};

  function ctx(user: TestUser): ConnectionContext {
    return { userId: user.userId, connectionId: cid[user.userId]! };
  }

  function startCall(user: TestUser, conversationId: string, media: "voice" | "video" = "voice") {
    return request(app).post("/api/v1/calls").set(auth(user)).send({ conversationId, media, connectionId: cid[user.userId] });
  }

  async function getCall(user: TestUser, callId: string): Promise<CallDTO> {
    const res = await request(app).get(`/api/v1/calls/${callId}`).set(auth(user));
    return res.body.call as CallDTO;
  }

  beforeAll(async () => {
    const db = await createTestDb();
    gateway = new FakeRealtimeGateway();
    ({ app, container } = createApp({ db, realtimeGateway: gateway, callRingTimeoutMs: RING_TIMEOUT_MS, callReconnectGraceMs: 50 }));
    alice = await signupTestUser(app, { displayName: "Alice" });
    bob = await signupTestUser(app, { displayName: "Bob" });
    carol = await signupTestUser(app, { displayName: "Carol" });
    eve = await signupTestUser(app, { displayName: "Eve" });
    for (const user of [alice, bob, carol, eve]) {
      cid[user.userId] = crypto.randomUUID();
      gateway.openConnections.add(`${user.userId}:${cid[user.userId]}`);
    }
  });

  afterAll(() => container.callsService.dispose());

  beforeEach(() => {
    gateway.sentEvents.length = 0;
    gateway.connectionEvents.length = 0;
  });

  describe("starting a call", () => {
    it("creates a ringing direct call and invites only the other member", async () => {
      const conversationId = await createDirectConversation(app, alice, bob);
      const res = await startCall(alice, conversationId, "video");

      expect(res.status).toBe(201);
      const call = res.body.call as CallDTO;
      expect(call).toMatchObject({ conversationId, scope: "direct", media: "video", state: "ringing", initiatorId: alice.userId });
      expect(call.participants.map((p) => [p.userId, p.role, p.state])).toEqual([
        [alice.userId, "initiator", "joined"],
        [bob.userId, "invitee", "invited"],
      ]);
      expect(gateway.eventsFor(bob.userId)).toEqual([expect.objectContaining({ type: "call:invite" })]);
      expect(gateway.eventsFor(eve.userId)).toEqual([]);

      await container.callsService.cancel(alice.userId, call.id);
    });

    it("rejects non-members, unauthenticated callers, and bad input", async () => {
      const conversationId = await createDirectConversation(app, alice, bob);
      expect((await startCall(eve, conversationId)).status).toBe(403);
      expect((await request(app).post("/api/v1/calls").send({ conversationId, media: "voice", connectionId: cid[alice.userId] })).status).toBe(401);
      expect((await request(app).post("/api/v1/calls").set(auth(alice)).send({ conversationId, media: "hologram", connectionId: cid[alice.userId] })).status).toBe(400);
      expect((await request(app).post("/api/v1/calls").set(auth(alice)).send({ conversationId: "nope", media: "voice", connectionId: cid[alice.userId] })).status).toBe(400);
    });

    it("requires the caller's own, open realtime connection", async () => {
      const conversationId = await createDirectConversation(app, alice, bob);
      // Bob's connection ID is real and open — but it isn't Alice's.
      const res = await request(app)
        .post("/api/v1/calls")
        .set(auth(alice))
        .send({ conversationId, media: "voice", connectionId: cid[bob.userId] });
      expect(res.status).toBe(409);
    });

    it("allows only one live call per conversation, and marks busy callees", async () => {
      const conversationId = await createDirectConversation(app, alice, bob);
      const first = await startCall(alice, conversationId);
      expect(first.status).toBe(201);
      expect((await startCall(bob, conversationId)).status).toBe(409);

      // Bob accepts, so he's now busy; Carol calling Bob is refused.
      await container.callsService.accept(ctx(bob), first.body.call.id);
      const carolBob = await createDirectConversation(app, carol, bob);
      const busy = await startCall(carol, carolBob);
      expect(busy.status).toBe(409);
      expect(busy.body.error.message).toMatch(/Bob is on another call/);

      await container.callsService.hangUp(alice.userId, first.body.call.id);
    });
  });

  describe("direct call lifecycle", () => {
    let conversationId: string;
    beforeAll(async () => {
      conversationId = await createDirectConversation(app, alice, carol);
    });

    it("ringing → accepted → connecting → connected → ended, with duration and history for both sides", async () => {
      const { body } = await startCall(alice, conversationId);
      const callId = body.call.id as string;

      await container.callsService.handleClientEvent(ctx(carol), { type: "call:ring", callId });
      expect(gateway.eventsFor(alice.userId)).toContainEqual({ type: "call:ring", callId, userId: carol.userId });

      await container.callsService.handleClientEvent(ctx(carol), { type: "call:accept", callId });
      expect((await getCall(alice, callId)).state).toBe("accepted");
      // Both sides (all their devices) learn who accepted.
      expect(gateway.eventsFor(alice.userId).some((e) => e.type === "call:accept")).toBe(true);
      expect(gateway.eventsFor(carol.userId).some((e) => e.type === "call:accept")).toBe(true);

      await container.callsService.handleClientEvent(ctx(carol), {
        type: "call:offer",
        callId,
        toUserId: alice.userId,
        sdp: "v=0 offer",
      });
      expect((await getCall(alice, callId)).state).toBe("connecting");
      // The offer is relayed to Alice's joined connection only.
      expect(gateway.connectionEvents).toContainEqual({
        userId: alice.userId,
        connectionId: cid[alice.userId],
        event: { type: "call:offer", callId, fromUserId: carol.userId, sdp: "v=0 offer" },
      });

      await container.callsService.handleClientEvent(ctx(alice), { type: "call:connected", callId });
      const connected = await getCall(carol, callId);
      expect(connected.state).toBe("connected");
      expect(connected.connectedAt).toBeTruthy();

      await delay(20);
      await container.callsService.handleClientEvent(ctx(carol), { type: "call:end", callId });
      const ended = await getCall(alice, callId);
      expect(ended).toMatchObject({ state: "ended", endReason: "hangup" });
      expect(ended.durationSeconds).toBeGreaterThanOrEqual(0);
      expect(ended.participants.every((p) => p.state === "left")).toBe(true);

      const aliceHistory = await request(app).get(`/api/v1/calls?conversationId=${conversationId}`).set(auth(alice));
      expect(aliceHistory.status).toBe(200);
      expect(aliceHistory.body.calls[0]).toMatchObject({ id: callId, direction: "outgoing", outcome: "completed" });
      const carolHistory = await request(app).get(`/api/v1/calls?conversationId=${conversationId}`).set(auth(carol));
      expect(carolHistory.body.calls[0]).toMatchObject({ id: callId, direction: "incoming", outcome: "completed" });

      // Metadata-only audit trail.
      const events = await container.db.query<{ event_type: string }>(
        "SELECT event_type FROM call_events WHERE call_id = $1 ORDER BY created_at",
        [callId]
      );
      expect(events.rows.map((r) => r.event_type)).toEqual(["created", "ringing", "accepted", "connected", "ended"]);
    });

    it("decline ends the call as declined for both sides", async () => {
      const { body } = await startCall(alice, conversationId);
      await container.callsService.handleClientEvent(ctx(carol), { type: "call:decline", callId: body.call.id });

      const call = await getCall(alice, body.call.id);
      expect(call).toMatchObject({ state: "declined", endReason: "declined" });
      expect(gateway.eventsFor(alice.userId).some((e) => e.type === "call:decline")).toBe(true);

      const history = await request(app).get(`/api/v1/calls?conversationId=${conversationId}`).set(auth(carol));
      expect(history.body.calls[0]).toMatchObject({ direction: "incoming", outcome: "declined" });
    });

    it("the caller can cancel while ringing; the callee sees it as missed", async () => {
      const { body } = await startCall(alice, conversationId);
      await container.callsService.handleClientEvent(ctx(alice), { type: "call:cancel", callId: body.call.id });

      expect((await getCall(carol, body.call.id)).state).toBe("cancelled");
      expect(gateway.eventsFor(carol.userId).some((e) => e.type === "call:cancel")).toBe(true);
      const history = await request(app).get(`/api/v1/calls?conversationId=${conversationId}`).set(auth(carol));
      expect(history.body.calls[0]).toMatchObject({ outcome: "missed" });
      const callerHistory = await request(app).get(`/api/v1/calls?conversationId=${conversationId}`).set(auth(alice));
      expect(callerHistory.body.calls[0]).toMatchObject({ outcome: "cancelled" });
    });

    it("an unanswered call becomes missed after the ring timeout", async () => {
      const { body } = await startCall(alice, conversationId, "video");
      await delay(RING_TIMEOUT_MS + 150);

      const call = await getCall(alice, body.call.id);
      expect(call).toMatchObject({ state: "missed", endReason: "no_answer" });
      expect(call.participants.find((p) => p.userId === carol.userId)?.state).toBe("missed");
      expect(gateway.eventsFor(carol.userId).some((e) => e.type === "call:end")).toBe(true);

      const history = await request(app).get(`/api/v1/calls?conversationId=${conversationId}`).set(auth(carol));
      expect(history.body.calls[0]).toMatchObject({ media: "video", direction: "incoming", outcome: "missed" });
    });

    it("a reported media failure ends a direct call as failed", async () => {
      const { body } = await startCall(alice, conversationId);
      await container.callsService.handleClientEvent(ctx(carol), { type: "call:accept", callId: body.call.id });
      await container.callsService.handleClientEvent(ctx(alice), {
        type: "call:failed",
        callId: body.call.id,
        reason: "connection_failed",
      });
      expect(await getCall(carol, body.call.id)).toMatchObject({ state: "failed", endReason: "connection_failed", durationSeconds: null });
    });

    it("POST /calls/:id/end hangs up whatever the caller's role (here: declining)", async () => {
      const { body } = await startCall(alice, conversationId);
      const res = await request(app).post(`/api/v1/calls/${body.call.id}/end`).set(auth(carol));
      expect(res.status).toBe(200);
      expect(res.body.call.state).toBe("declined");
      expect((await request(app).post(`/api/v1/calls/${body.call.id}/end`).set(auth(eve))).status).toBe(403);
    });
  });

  describe("invalid transitions and authorization", () => {
    let conversationId: string;
    let callId: string;

    beforeEach(async () => {
      conversationId = conversationId ?? (await createDirectConversation(app, bob, carol));
      const res = await startCall(bob, conversationId);
      callId = res.body.call.id;
    });

    it("rejects answering/declining/cancelling by the wrong party", async () => {
      const service = container.callsService;
      // The caller is already in the call from this device: "accepting" is a no-op, not an answer.
      await service.accept(ctx(bob), callId);
      expect((await getCall(bob, callId)).state).toBe("ringing");
      await expect(service.accept(ctx(eve), callId)).rejects.toMatchObject({ statusCode: 403 });
      await expect(service.decline(eve.userId, callId)).rejects.toMatchObject({ statusCode: 403 });
      await expect(service.cancel(carol.userId, callId)).rejects.toMatchObject({ statusCode: 403 });
      await service.cancel(bob.userId, callId);
    });

    it("rejects any transition on a call that has ended", async () => {
      await container.callsService.cancel(bob.userId, callId);
      await expect(container.callsService.accept(ctx(carol), callId)).rejects.toMatchObject({ statusCode: 409 });
      await expect(container.callsService.cancel(bob.userId, callId)).rejects.toMatchObject({ statusCode: 409 });
      await expect(container.callsService.decline(carol.userId, callId)).rejects.toMatchObject({ statusCode: 409 });
    });

    it("can't cancel after the call was answered", async () => {
      await container.callsService.accept(ctx(carol), callId);
      await expect(container.callsService.cancel(bob.userId, callId)).rejects.toMatchObject({ statusCode: 409 });
      await container.callsService.hangUp(bob.userId, callId);
    });

    it("refuses signaling from non-participants, not-yet-joined invitees, and other devices", async () => {
      const service = container.callsService;
      const offer = (from: ConnectionContext, toUserId: string) =>
        service.handleClientEvent(from, { type: "call:offer", callId, toUserId, sdp: "v=0" });

      await expect(offer(ctx(eve), bob.userId)).rejects.toMatchObject({ statusCode: 403 });
      // Carol hasn't accepted yet.
      await expect(offer(ctx(carol), bob.userId)).rejects.toMatchObject({ statusCode: 403 });
      // Bob → Carol before Carol joined: target not in call.
      await expect(offer(ctx(bob), carol.userId)).rejects.toMatchObject({ statusCode: 409 });

      await service.accept(ctx(carol), callId);
      // Right user, wrong device.
      await expect(offer({ userId: carol.userId, connectionId: crypto.randomUUID() }, bob.userId)).rejects.toMatchObject({
        statusCode: 403,
      });
      await expect(offer(ctx(carol), carol.userId)).rejects.toMatchObject({ statusCode: 400 });
      expect(gateway.connectionEvents).toEqual([]);

      await service.hangUp(carol.userId, callId);
    });

    it("hides calls and history from outsiders", async () => {
      expect((await request(app).get(`/api/v1/calls/${callId}`).set(auth(eve))).status).toBe(403);
      expect((await request(app).get(`/api/v1/calls?conversationId=${conversationId}`).set(auth(eve))).status).toBe(403);
      expect((await request(app).get(`/api/v1/calls/active?conversationId=${conversationId}`).set(auth(eve))).status).toBe(403);
      const evesHistory = await request(app).get("/api/v1/calls").set(auth(eve));
      expect(evesHistory.body.calls.map((c: CallDTO) => c.id)).not.toContain(callId);
      await container.callsService.cancel(bob.userId, callId);
    });
  });

  describe("group calls", () => {
    it("invites every member; members join and leave; the call ends when the last one leaves", async () => {
      const { conversationId } = await createGroup(app, alice, [bob, carol]);
      const res = await startCall(alice, conversationId, "video");
      expect(res.status).toBe(201);
      const callId = res.body.call.id as string;
      expect(res.body.call.scope).toBe("group");
      for (const user of [bob, carol]) {
        expect(gateway.eventsFor(user.userId).some((e) => e.type === "call:invite")).toBe(true);
      }

      // A group call already in progress is joined, not duplicated.
      expect((await startCall(bob, conversationId)).status).toBe(409);
      const active = await request(app).get(`/api/v1/calls/active?conversationId=${conversationId}`).set(auth(bob));
      expect(active.body.call.id).toBe(callId);

      await container.callsService.accept(ctx(bob), callId);
      await container.callsService.decline(carol.userId, callId);
      let call = await getCall(alice, callId);
      expect(call.state).toBe("accepted");
      expect(call.participants.map((p) => [p.displayName, p.state])).toEqual([
        ["Alice", "joined"],
        ["Bob", "joined"],
        ["Carol", "declined"],
      ]);

      // Carol changes her mind and joins; then mic/camera state is shared.
      await container.callsService.accept(ctx(carol), callId);
      await container.callsService.handleClientEvent(ctx(carol), {
        type: "call:media_state",
        callId,
        audioEnabled: false,
        videoEnabled: true,
      });
      call = await getCall(bob, callId);
      expect(call.participants.find((p) => p.userId === carol.userId)).toMatchObject({ audioEnabled: false, videoEnabled: true });

      await container.callsService.hangUp(alice.userId, callId);
      expect(gateway.eventsFor(bob.userId).some((e) => e.type === "call:participant_left")).toBe(true);
      expect((await getCall(bob, callId)).state).toBe("accepted");

      await container.callsService.hangUp(bob.userId, callId);
      await container.callsService.hangUp(carol.userId, callId);
      expect(await getCall(bob, callId)).toMatchObject({ state: "ended", endReason: "all_left" });
    });

    it("declines the whole call once every invitee declined", async () => {
      const { conversationId } = await createGroup(app, alice, [bob, carol]);
      const { body } = await startCall(alice, conversationId);
      await container.callsService.decline(bob.userId, body.call.id);
      expect((await getCall(alice, body.call.id)).state).toBe("ringing");
      await container.callsService.decline(carol.userId, body.call.id);
      expect((await getCall(alice, body.call.id)).state).toBe("declined");
    });

    it("keeps removed members and outsiders out", async () => {
      const { conversationId, groupId } = await createGroup(app, alice, [bob, carol]);
      const { body } = await startCall(alice, conversationId);
      await request(app).delete(`/api/v1/groups/${groupId}/members/${carol.userId}`).set(auth(alice));
      await expect(container.callsService.accept(ctx(carol), body.call.id)).rejects.toMatchObject({ statusCode: 403 });
      await expect(container.callsService.accept(ctx(eve), body.call.id)).rejects.toMatchObject({ statusCode: 403 });
      await container.callsService.cancel(alice.userId, body.call.id);
    });
  });

  describe("connection loss", () => {
    it("ends a direct call when a joined device disconnects and doesn't come back", async () => {
      const conversationId = await createDirectConversation(app, alice, eve);
      const { body } = await startCall(alice, conversationId);
      await container.callsService.accept(ctx(eve), body.call.id);

      gateway.openConnections.delete(`${eve.userId}:${cid[eve.userId]}`);
      container.callsService.handleDisconnect(ctx(eve));
      await delay(150);

      expect(await getCall(alice, body.call.id)).toMatchObject({ state: "ended", endReason: "disconnected" });
      gateway.openConnections.add(`${eve.userId}:${cid[eve.userId]}`);
    });

    it("survives a reconnect within the grace period", async () => {
      const conversationId = await createDirectConversation(app, alice, eve);
      const { body } = await startCall(alice, conversationId);
      await container.callsService.accept(ctx(eve), body.call.id);

      container.callsService.handleDisconnect(ctx(eve));
      container.callsService.handleConnect(ctx(eve));
      await delay(150);

      expect((await getCall(alice, body.call.id)).state).toBe("accepted");
      await container.callsService.hangUp(alice.userId, body.call.id);
    });

    it("recovers calls left live by a previous server run as failed", async () => {
      const conversationId = await createDirectConversation(app, bob, eve);
      const { body } = await startCall(bob, conversationId);
      expect(await container.callsService.recoverStaleCalls()).toBeGreaterThanOrEqual(1);
      expect(await getCall(bob, body.call.id)).toMatchObject({ state: "failed", endReason: "server_restart" });
    });
  });

  describe("ICE servers", () => {
    it("requires authentication and returns the configured list", async () => {
      expect((await request(app).get("/api/v1/calls/ice-servers")).status).toBe(401);
      const res = await request(app).get("/api/v1/calls/ice-servers").set(auth(alice));
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.iceServers)).toBe(true);
      expect(res.headers["cache-control"]).toContain("no-store");
    });
  });
});
