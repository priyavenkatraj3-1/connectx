import { createHmac } from "crypto";
import { describe, expect, it } from "vitest";
import { toHistoryEntry } from "../../src/modules/calls/calls.service";
import type { CallDTO } from "../../src/modules/calls/calls.types";
import { buildIceServers } from "../../src/modules/calls/ice-servers";
import { parseClientEvent } from "../../src/realtime/client-events";

const CALL = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

describe("parseClientEvent (WebSocket input validation)", () => {
  it("accepts well-formed call events and strips nothing it needs", () => {
    expect(parseClientEvent(JSON.stringify({ type: "call:accept", callId: CALL }))).toEqual({
      ok: true,
      event: { type: "call:accept", callId: CALL },
    });
    const ice = { candidate: "candidate:1 1 udp 2122260223 10.0.0.2 54321 typ host", sdpMid: "0", sdpMLineIndex: 0 };
    expect(parseClientEvent(JSON.stringify({ type: "call:ice_candidate", callId: CALL, toUserId: USER, candidate: ice }))).toEqual({
      ok: true,
      event: { type: "call:ice_candidate", callId: CALL, toUserId: USER, candidate: ice },
    });
  });

  it("drops identity fields a client tries to smuggle in", () => {
    const parsed = parseClientEvent(JSON.stringify({ type: "call:accept", callId: CALL, userId: USER, fromUserId: USER }));
    expect(parsed).toEqual({ ok: true, event: { type: "call:accept", callId: CALL } });
  });

  it.each([
    ["missing callId", { type: "call:accept" }],
    ["non-UUID callId", { type: "call:end", callId: "../../etc" }],
    ["missing target", { type: "call:offer", callId: CALL, sdp: "v=0" }],
    ["empty SDP", { type: "call:answer", callId: CALL, toUserId: USER, sdp: "" }],
    ["oversized SDP", { type: "call:offer", callId: CALL, toUserId: USER, sdp: "x".repeat(64 * 1024 + 1) }],
    ["SDP of the wrong type", { type: "call:offer", callId: CALL, toUserId: USER, sdp: { evil: true } }],
    ["unknown ICE fields", { type: "call:ice_candidate", callId: CALL, toUserId: USER, candidate: { candidate: "", extra: 1 } }],
    ["bad failure reason", { type: "call:failed", callId: CALL, reason: "because" }],
    ["non-boolean media state", { type: "call:media_state", callId: CALL, audioEnabled: "yes", videoEnabled: true }],
  ])("rejects a malformed call event: %s", (_label, payload) => {
    const parsed = parseClientEvent(JSON.stringify(payload));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.kind).toBe("invalid");
  });

  it("echoes a valid callId on rejection so the client can correlate it", () => {
    expect(parseClientEvent(JSON.stringify({ type: "call:offer", callId: CALL }))).toMatchObject({ ok: false, callId: CALL });
    expect(parseClientEvent(JSON.stringify({ type: "call:offer", callId: "nope" }))).toMatchObject({ ok: false, callId: null });
  });

  it("ignores non-JSON frames and unknown event types", () => {
    expect(parseClientEvent("not json")).toEqual({ ok: false, kind: "ignored" });
    expect(parseClientEvent(JSON.stringify({ type: "call:teleport", callId: CALL }))).toEqual({ ok: false, kind: "ignored" });
    expect(parseClientEvent(JSON.stringify([1, 2]))).toEqual({ ok: false, kind: "ignored" });
  });
});

describe("buildIceServers", () => {
  const base = { stunUrls: [], turnUrls: [], turnCredentialTtlSeconds: 600 };

  it("is empty by default — no third-party servers unless configured", () => {
    expect(buildIceServers(base, USER)).toEqual([]);
  });

  it("includes STUN, and omits TURN that has no credentials", () => {
    expect(buildIceServers({ ...base, stunUrls: ["stun:stun.example.com:3478"], turnUrls: ["turn:turn.example.com"] }, USER)).toEqual([
      { urls: ["stun:stun.example.com:3478"] },
    ]);
  });

  it("uses static TURN credentials when configured", () => {
    expect(
      buildIceServers({ ...base, turnUrls: ["turn:t.example.com"], turnUsername: "u", turnCredential: "p" }, USER)
    ).toEqual([{ urls: ["turn:t.example.com"], username: "u", credential: "p" }]);
  });

  it("derives short-lived TURN REST credentials from a shared secret, without exposing the secret", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const [server] = buildIceServers({ ...base, turnUrls: ["turn:t.example.com"], turnSecret: "s3cret" }, USER, now);
    const expiry = Math.floor(now.getTime() / 1000) + 600;
    expect(server).toEqual({
      urls: ["turn:t.example.com"],
      username: `${expiry}:${USER}`,
      credential: createHmac("sha1", "s3cret").update(`${expiry}:${USER}`).digest("base64"),
    });
    expect(JSON.stringify(server)).not.toContain("s3cret");
  });
});

describe("toHistoryEntry", () => {
  const participant = (userId: string, role: "initiator" | "invitee", state: CallDTO["participants"][number]["state"], joined: boolean) => ({
    userId,
    displayName: userId,
    avatarUrl: null,
    role,
    state,
    joinedAt: joined ? new Date() : null,
    leftAt: null,
    audioEnabled: null,
    videoEnabled: null,
  });
  const call = (state: CallDTO["state"], calleeState: CallDTO["participants"][number]["state"], calleeJoined: boolean): CallDTO => ({
    id: CALL,
    conversationId: CALL,
    scope: "direct",
    media: "voice",
    state,
    endReason: null,
    initiatorId: "caller",
    createdAt: new Date(),
    answeredAt: null,
    connectedAt: null,
    endedAt: null,
    durationSeconds: null,
    participants: [participant("caller", "initiator", "left", true), participant("callee", "invitee", calleeState, calleeJoined)],
  });

  it.each([
    ["ended", "left", true, "caller", "outgoing", "completed"],
    ["ended", "left", true, "callee", "incoming", "completed"],
    ["missed", "missed", false, "caller", "outgoing", "no_answer"],
    ["missed", "missed", false, "callee", "incoming", "missed"],
    ["declined", "declined", false, "callee", "incoming", "declined"],
    ["cancelled", "missed", false, "callee", "incoming", "missed"],
    ["cancelled", "missed", false, "caller", "outgoing", "cancelled"],
    ["connected", "joined", true, "callee", "incoming", "ongoing"],
  ] as const)("%s call, callee %s → %s sees %s/%s", (state, calleeState, joined, viewer, direction, outcome) => {
    expect(toHistoryEntry(call(state, calleeState, joined), viewer)).toMatchObject({ direction, outcome });
  });
});
