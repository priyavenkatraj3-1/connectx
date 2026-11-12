import { act } from "@testing-library/react";
import { vi } from "vitest";
import type { RealtimeContextValue } from "../context/RealtimeContext";
import type { CallDTO, CallParticipantDTO } from "../types/call";
import type { ClientEvent, ServerEvent } from "../types/realtime";

/**
 * jsdom has no WebRTC or camera. These fakes stand in for
 * RTCPeerConnection / getUserMedia / the realtime socket so call flows can
 * be tested end to end in the UI — they verify our signaling and state
 * handling, not real media (that needs the manual test plan).
 */

export interface FakeTrack {
  kind: "audio" | "video";
  enabled: boolean;
  stop: ReturnType<typeof vi.fn>;
}

export function createFakeStream(kinds: Array<"audio" | "video">) {
  const tracks: FakeTrack[] = kinds.map((kind) => ({ kind, enabled: true, stop: vi.fn() }));
  return {
    tracks,
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
    getVideoTracks: () => tracks.filter((t) => t.kind === "video"),
  } as unknown as MediaStream & { tracks: FakeTrack[] };
}

export function createFakeMediaDevices(behavior: { error?: { name: string } } = {}) {
  return {
    getUserMedia: vi.fn(async (constraints: MediaStreamConstraints) => {
      if (behavior.error) throw behavior.error;
      return createFakeStream(constraints.video ? ["audio", "video"] : ["audio"]);
    }),
  } as unknown as MediaDevices & { getUserMedia: ReturnType<typeof vi.fn> };
}

export class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  remoteDescription: RTCSessionDescriptionInit | null = null;
  localDescription: RTCSessionDescriptionInit | null = null;
  connectionState: RTCPeerConnectionState = "new";
  onicecandidate: ((e: { candidate: unknown }) => void) | null = null;
  ontrack: ((e: unknown) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  readonly addedTracks: unknown[] = [];
  readonly addedCandidates: unknown[] = [];

  constructor(public readonly config: RTCConfiguration) {
    FakePeerConnection.instances.push(this);
  }
  addTrack(track: unknown) {
    this.addedTracks.push(track);
  }
  async createOffer() {
    return { type: "offer" as const, sdp: "fake-offer-sdp" };
  }
  async createAnswer() {
    return { type: "answer" as const, sdp: "fake-answer-sdp" };
  }
  async setLocalDescription(d: RTCSessionDescriptionInit) {
    this.localDescription = d;
  }
  async setRemoteDescription(d: RTCSessionDescriptionInit) {
    this.remoteDescription = d;
  }
  async addIceCandidate(c: unknown) {
    this.addedCandidates.push(c);
  }
  close() {
    this.connectionState = "closed";
  }
  /** Simulates the browser reporting a new connection state. */
  setState(state: RTCPeerConnectionState) {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
}

export function fakePeerFactory(config: RTCConfiguration): RTCPeerConnection {
  return new FakePeerConnection(config) as unknown as RTCPeerConnection;
}

/** A realtime channel the test drives: `emit` delivers server events, `sent` records client events. */
export function createFakeRealtime(connectionId = "11111111-1111-4111-8111-111111111111") {
  const listeners = new Set<(event: ServerEvent) => void>();
  const reconnectListeners = new Set<() => void>();
  const sent: ClientEvent[] = [];
  const value: RealtimeContextValue = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send(event) {
      sent.push(event);
      return true;
    },
    connectionId,
    onReconnect(listener) {
      reconnectListeners.add(listener);
      return () => reconnectListeners.delete(listener);
    },
  };
  return {
    value,
    sent,
    emit(event: ServerEvent) {
      act(() => {
        for (const listener of listeners) listener(event);
      });
    },
    /** Simulates the socket coming back after an unexpected drop. */
    reconnect() {
      act(() => {
        for (const listener of reconnectListeners) listener();
      });
    },
  };
}

export function participant(
  userId: string,
  displayName: string,
  role: "initiator" | "invitee",
  state: CallParticipantDTO["state"]
): CallParticipantDTO {
  return { userId, displayName, avatarUrl: null, role, state, joinedAt: null, leftAt: null, audioEnabled: null, videoEnabled: null };
}

export function makeCall(overrides: Partial<CallDTO> = {}): CallDTO {
  return {
    id: "call-1",
    conversationId: "conv-1",
    scope: "direct",
    media: "voice",
    state: "ringing",
    endReason: null,
    initiatorId: "user-1",
    createdAt: new Date().toISOString(),
    answeredAt: null,
    connectedAt: null,
    endedAt: null,
    durationSeconds: null,
    participants: [participant("user-1", "Test User", "initiator", "joined"), participant("user-2", "Grace Hopper", "invitee", "invited")],
    ...overrides,
  };
}
