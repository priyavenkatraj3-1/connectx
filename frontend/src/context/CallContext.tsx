import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { acquireLocalMedia, checkCallSupport, friendlyMediaError } from "../lib/webrtc/mediaErrors";
import { PeerMesh, type PeerConnectionFactory } from "../lib/webrtc/peerMesh";
import { ApiError } from "../services/apiClient";
import { callService } from "../services/callService";
import { isLiveCall, type CallDTO, type CallMedia } from "../types/call";
import type { CallClientEvent, ServerEvent } from "../types/realtime";
import { useAuth } from "./AuthContext";
import { useRealtime } from "./RealtimeContext";

/**
 * idle     — no call in this tab
 * outgoing — we placed a call; nobody has answered yet
 * active   — the call was answered / we joined; media is connecting or connected
 * ended    — the call just finished; a summary is showing
 * (An incoming call rings separately, via `incomingCall`, while idle.)
 */
export type CallPhase = "idle" | "outgoing" | "active" | "ended";

export interface CallEndSummary {
  title: string;
  detail?: string;
  /** Offer "Call again" (failures, no answer). */
  canRetry: boolean;
}

export interface CallContextValue {
  phase: CallPhase;
  /** The call this tab is placing / in / just finished. */
  call: CallDTO | null;
  /** A call ringing for us while we're free. */
  incomingCall: CallDTO | null;
  localStream: MediaStream | null;
  remoteStreams: Record<string, MediaStream>;
  peerStates: Record<string, RTCPeerConnectionState>;
  micEnabled: boolean;
  cameraEnabled: boolean;
  /** At least one callee device acknowledged the invite ("Ringing…" vs "Calling…"). */
  remoteRinging: boolean;
  /** Non-fatal, user-facing notice (e.g. camera unavailable, a rejected action). */
  notice: string | null;
  /** A problem that stopped a call from starting (permissions, unsupported browser, busy…). */
  error: string | null;
  endSummary: CallEndSummary | null;
  isStarting: boolean;
  /** True while this tab is placing, ringing or in a call. */
  isBusy: boolean;
  startCall(conversationId: string, media: CallMedia): Promise<void>;
  acceptIncoming(): Promise<void>;
  declineIncoming(): void;
  /** Join a group call that's already in progress. */
  joinCall(call: CallDTO): Promise<void>;
  hangUp(): void;
  toggleMic(): void;
  toggleCamera(): void;
  retry(): void;
  dismiss(): void;
}

const CallContext = createContext<CallContextValue | undefined>(undefined);

const ENDED_SCREEN_MS = 3500;

interface CallProviderProps {
  children: ReactNode;
  /** Injectable for tests; defaults to the browser's implementations. */
  mediaDevices?: MediaDevices;
  createPeerConnection?: PeerConnectionFactory;
}

function describeEnd(call: CallDTO, myId: string | undefined): CallEndSummary {
  const others = call.participants.filter((p) => p.userId !== myId);
  const name = call.scope === "direct" ? (others[0]?.displayName ?? "They") : "The group";
  switch (call.state) {
    case "declined":
      return { title: call.scope === "direct" ? `${name} declined the call` : "Everyone declined", canRetry: false };
    case "missed":
      return call.initiatorId === myId
        ? { title: "No answer", detail: `${name} didn't pick up.`, canRetry: true }
        : { title: "Missed call", canRetry: false };
    case "cancelled":
      return { title: "Call cancelled", canRetry: false };
    case "failed":
      return {
        title: "Call failed",
        detail:
          call.endReason === "server_restart"
            ? "The call was interrupted."
            : "Couldn't connect. On restrictive networks calls may need a TURN relay server.",
        canRetry: true,
      };
    default: {
      const detail = call.durationSeconds !== null ? formatCallDuration(call.durationSeconds) : undefined;
      return {
        title: call.endReason === "disconnected" ? "Call ended — connection lost" : "Call ended",
        detail,
        canRetry: call.endReason === "disconnected",
      };
    }
  }
}

export function formatCallDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mmss = `${String(minutes).padStart(hours ? 2 : 1, "0")}:${String(seconds).padStart(2, "0")}`;
  return hours ? `${hours}:${mmss}` : mmss;
}

export function CallProvider({ children, mediaDevices, createPeerConnection }: CallProviderProps) {
  const { accessToken, user } = useAuth();
  const { subscribe, send, connectionId } = useRealtime();
  const myId = user?.id;

  const devices = mediaDevices ?? (typeof navigator !== "undefined" ? navigator.mediaDevices : undefined);
  const peerFactory = useMemo<PeerConnectionFactory | undefined>(
    () =>
      createPeerConnection ??
      (typeof RTCPeerConnection !== "undefined" ? (config: RTCConfiguration) => new RTCPeerConnection(config) : undefined),
    [createPeerConnection]
  );

  const [phase, setPhase] = useState<CallPhase>("idle");
  const [call, setCall] = useState<CallDTO | null>(null);
  const [incomingCall, setIncomingCall] = useState<CallDTO | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({});
  const [peerStates, setPeerStates] = useState<Record<string, RTCPeerConnectionState>>({});
  const [micEnabled, setMicEnabled] = useState(true);
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [remoteRinging, setRemoteRinging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [endSummary, setEndSummary] = useState<CallEndSummary | null>(null);
  const [isStarting, setIsStarting] = useState(false);

  // Refs mirror state that async event handlers need synchronously.
  const phaseRef = useRef<CallPhase>("idle");
  const callIdRef = useRef<string | null>(null);
  const incomingRef = useRef<CallDTO | null>(null);
  const meshRef = useRef<PeerMesh | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const pendingAcceptRef = useRef<string | null>(null);
  const reportedConnectedRef = useRef(false);
  const lastRequestRef = useRef<{ conversationId: string; media: CallMedia } | null>(null);
  const endedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const iceServersRef = useRef<Awaited<ReturnType<typeof callService.iceServers>> | null>(null);

  const updatePhase = useCallback((next: CallPhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const updateIncoming = useCallback((next: CallDTO | null) => {
    incomingRef.current = next;
    setIncomingCall(next);
  }, []);

  const sendSignal = useCallback((event: CallClientEvent) => send(event), [send]);

  /** Tears down media and peers. Keeps `call` so the ended screen can describe it. */
  const releaseMedia = useCallback(() => {
    meshRef.current?.closeAll();
    meshRef.current = null;
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    setLocalStream(null);
    setRemoteStreams({});
    setPeerStates({});
    pendingAcceptRef.current = null;
    reportedConnectedRef.current = false;
  }, []);

  const resetToIdle = useCallback(() => {
    if (endedTimerRef.current) clearTimeout(endedTimerRef.current);
    endedTimerRef.current = null;
    releaseMedia();
    callIdRef.current = null;
    setCall(null);
    setEndSummary(null);
    setNotice(null);
    setError(null);
    setRemoteRinging(false);
    setMicEnabled(true);
    setCameraEnabled(true);
    updatePhase("idle");
  }, [releaseMedia, updatePhase]);

  const finishCall = useCallback(
    (finalCall: CallDTO | null, summary: CallEndSummary) => {
      releaseMedia();
      if (finalCall) setCall(finalCall);
      setEndSummary(summary);
      updatePhase("ended");
      if (endedTimerRef.current) clearTimeout(endedTimerRef.current);
      if (!summary.canRetry) {
        endedTimerRef.current = setTimeout(() => {
          if (phaseRef.current === "ended") resetToIdle();
        }, ENDED_SCREEN_MS);
      }
    },
    [releaseMedia, resetToIdle, updatePhase]
  );

  const getIceServers = useCallback(async () => {
    if (iceServersRef.current) return iceServersRef.current;
    if (!accessToken) return [];
    try {
      iceServersRef.current = await callService.iceServers(accessToken);
    } catch {
      iceServersRef.current = [];
    }
    return iceServersRef.current;
  }, [accessToken]);

  /**
   * Gets the camera/mic (asking permission once) and the ICE server list.
   * Throws an Error with a friendly message if calling isn't possible.
   */
  const acquireMedia = useCallback(
    async (media: CallMedia) => {
      const unsupported = checkCallSupport({ mediaDevices: devices, hasPeerConnection: !!peerFactory });
      if (unsupported) throw new Error(unsupported);
      let acquired: Awaited<ReturnType<typeof acquireLocalMedia>>;
      try {
        acquired = await acquireLocalMedia(devices!, media);
      } catch (err) {
        throw new Error(friendlyMediaError(err, media).message);
      }
      const iceServers = await getIceServers();
      return { ...acquired, iceServers };
    },
    [devices, peerFactory, getIceServers]
  );

  /** Installs the local stream and a fresh PeerMesh for `callId` — synchronously, so no early offer is missed. */
  const setupMesh = useCallback(
    (callId: string, media: CallMedia, acquired: Awaited<ReturnType<typeof acquireMedia>>) => {
      const { stream, cameraUnavailable, iceServers } = acquired;
      localStreamRef.current = stream;
      setLocalStream(stream);
      setMicEnabled(true);
      setCameraEnabled(media === "video" && !cameraUnavailable);
      if (cameraUnavailable) setNotice("Your camera isn't available — you're on audio only.");

      meshRef.current = new PeerMesh({
        callId,
        localStream: stream,
        iceServers,
        createPeerConnection: peerFactory!,
        sendSignal,
        onRemoteStream: (userId, remote) => setRemoteStreams((prev) => ({ ...prev, [userId]: remote })),
        onPeerStateChange: (userId, state) => {
          setPeerStates((prev) => ({ ...prev, [userId]: state }));
          if (callIdRef.current !== callId) return;
          if (state === "connected" && !reportedConnectedRef.current) {
            reportedConnectedRef.current = true;
            sendSignal({ type: "call:connected", callId });
          } else if (state === "failed") {
            sendSignal({ type: "call:failed", callId, reason: "connection_failed" });
          }
        },
      });
    },
    [sendSignal]
  );

  const startCall = useCallback(
    async (conversationId: string, media: CallMedia) => {
      if (!accessToken || phaseRef.current === "outgoing" || phaseRef.current === "active") return;
      resetToIdle();
      lastRequestRef.current = { conversationId, media };
      setIsStarting(true);

      // Get permission *before* ringing anyone, so we never ring people for a call we can't make.
      let acquired: Awaited<ReturnType<typeof acquireMedia>>;
      try {
        acquired = await acquireMedia(media);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't start the call");
        setIsStarting(false);
        return;
      }

      try {
        const created = await callService.start(accessToken, conversationId, media, connectionId);
        callIdRef.current = created.id;
        setupMesh(created.id, media, acquired);
        setCall(created);
        updatePhase("outgoing");
      } catch (err) {
        acquired.stream.getTracks().forEach((track) => track.stop());
        releaseMedia();
        callIdRef.current = null;
        setError(err instanceof ApiError || err instanceof Error ? err.message : "Couldn't start the call");
      } finally {
        setIsStarting(false);
      }
    },
    [accessToken, connectionId, acquireMedia, setupMesh, releaseMedia, resetToIdle, updatePhase]
  );

  /** Shared by accepting an incoming call and joining a group call in progress. */
  const joinInternal = useCallback(
    async (target: CallDTO) => {
      if (phaseRef.current === "outgoing" || phaseRef.current === "active") return;
      resetToIdle();
      callIdRef.current = target.id;
      setCall(target);
      lastRequestRef.current = { conversationId: target.conversationId, media: target.media };
      setIsStarting(true);
      try {
        setupMesh(target.id, target.media, await acquireMedia(target.media));
      } catch (err) {
        releaseMedia();
        callIdRef.current = null;
        setCall(null);
        setError(err instanceof Error ? err.message : "Couldn't join the call");
        setIsStarting(false);
        return false;
      }
      pendingAcceptRef.current = target.id;
      if (!send({ type: "call:accept", callId: target.id })) {
        releaseMedia();
        callIdRef.current = null;
        setCall(null);
        setError("You're offline. Check your connection and try again.");
        setIsStarting(false);
        return false;
      }
      updatePhase("active");
      setIsStarting(false);
      return true;
    },
    [acquireMedia, setupMesh, releaseMedia, resetToIdle, send, updatePhase]
  );

  const acceptIncoming = useCallback(async () => {
    const incoming = incomingRef.current;
    if (!incoming) return;
    updateIncoming(null);
    const joined = await joinInternal(incoming);
    if (!joined) {
      // We couldn't take the call (e.g. permission denied): decline so the caller isn't left ringing.
      send({ type: "call:decline", callId: incoming.id });
    }
  }, [joinInternal, send, updateIncoming]);

  const declineIncoming = useCallback(() => {
    const incoming = incomingRef.current;
    if (!incoming) return;
    updateIncoming(null);
    if (!send({ type: "call:decline", callId: incoming.id }) && accessToken) {
      void callService.end(accessToken, incoming.id).catch(() => undefined);
    }
  }, [accessToken, send, updateIncoming]);

  const joinCall = useCallback(
    async (target: CallDTO) => {
      await joinInternal(target);
    },
    [joinInternal]
  );

  const hangUp = useCallback(() => {
    const callId = callIdRef.current;
    if (!callId) {
      resetToIdle();
      return;
    }
    if (!send({ type: "call:end", callId }) && accessToken) {
      void callService.end(accessToken, callId).catch(() => undefined);
    }
    const current = call;
    finishCall(null, {
      title: phaseRef.current === "outgoing" ? "Call cancelled" : "Call ended",
      detail: current?.connectedAt ? formatCallDuration(Math.round((Date.now() - new Date(current.connectedAt).getTime()) / 1000)) : undefined,
      canRetry: false,
    });
    callIdRef.current = null;
  }, [accessToken, call, finishCall, resetToIdle, send]);

  const reportMediaState = useCallback(
    (audioEnabled: boolean, videoEnabled: boolean) => {
      const callId = callIdRef.current;
      if (callId && phaseRef.current === "active") send({ type: "call:media_state", callId, audioEnabled, videoEnabled });
    },
    [send]
  );

  const toggleMic = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const next = !stream.getAudioTracks().some((t) => t.enabled);
    stream.getAudioTracks().forEach((track) => (track.enabled = next));
    setMicEnabled(next);
    reportMediaState(next, stream.getVideoTracks().some((t) => t.enabled));
  }, [reportMediaState]);

  const toggleCamera = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream || stream.getVideoTracks().length === 0) return;
    const next = !stream.getVideoTracks().some((t) => t.enabled);
    stream.getVideoTracks().forEach((track) => (track.enabled = next));
    setCameraEnabled(next);
    reportMediaState(stream.getAudioTracks().some((t) => t.enabled), next);
  }, [reportMediaState]);

  const retry = useCallback(() => {
    const last = lastRequestRef.current;
    resetToIdle();
    if (last) void startCall(last.conversationId, last.media);
  }, [resetToIdle, startCall]);

  const dismiss = useCallback(() => resetToIdle(), [resetToIdle]);

  // --- Server events -------------------------------------------------------

  useEffect(() => {
    return subscribe((event: ServerEvent) => {
      switch (event.type) {
        case "call:invite": {
          const busy = phaseRef.current === "outgoing" || phaseRef.current === "active";
          if (busy || incomingRef.current) return; // it will ring out and show as missed
          updateIncoming(event.call);
          send({ type: "call:ring", callId: event.call.id });
          return;
        }
        case "call:ring":
          if (event.callId === callIdRef.current) setRemoteRinging(true);
          return;
        case "call:accept": {
          if (incomingRef.current?.id === event.call.id && event.userId === myId) {
            updateIncoming(null); // answered on another device
            return;
          }
          if (event.call.id !== callIdRef.current) return;
          setCall(event.call);
          if (event.userId === myId && pendingAcceptRef.current === event.call.id) {
            pendingAcceptRef.current = null;
            // We are the joiner: offer to everyone already in the call.
            const mesh = meshRef.current;
            for (const p of event.call.participants) {
              if (p.userId !== myId && p.state === "joined") void mesh?.connectTo(p.userId).catch(() => undefined);
            }
          } else if (event.userId !== myId && phaseRef.current === "outgoing") {
            updatePhase("active");
          }
          return;
        }
        case "call:decline":
        case "call:cancel":
        case "call:end": {
          if (incomingRef.current?.id === event.call.id && !isLiveCall(event.call)) {
            updateIncoming(null);
            return;
          }
          if (incomingRef.current?.id === event.call.id && event.type === "call:decline" && event.userId === myId) {
            updateIncoming(null); // declined on another device
            return;
          }
          if (event.call.id !== callIdRef.current) return;
          if (isLiveCall(event.call)) {
            setCall(event.call);
            return;
          }
          if (phaseRef.current !== "ended") finishCall(event.call, describeEnd(event.call, myId));
          else setCall(event.call);
          return;
        }
        case "call:failed": {
          if (event.call.id !== callIdRef.current) return;
          if (isLiveCall(event.call)) {
            meshRef.current?.remove(event.userId);
            setCall(event.call);
            return;
          }
          finishCall(event.call, describeEnd(event.call, myId));
          return;
        }
        case "call:participant_left":
          if (event.call.id !== callIdRef.current) return;
          meshRef.current?.remove(event.userId);
          setRemoteStreams((prev) => {
            const { [event.userId]: _gone, ...rest } = prev;
            return rest;
          });
          setCall(event.call);
          return;
        case "call:updated":
          if (event.call.id === callIdRef.current) setCall(event.call);
          else if (incomingRef.current?.id === event.call.id) updateIncoming(event.call);
          return;
        case "call:offer":
          if (event.callId === callIdRef.current) void meshRef.current?.handleOffer(event.fromUserId, event.sdp).catch(() => undefined);
          return;
        case "call:answer":
          if (event.callId === callIdRef.current) void meshRef.current?.handleAnswer(event.fromUserId, event.sdp).catch(() => undefined);
          return;
        case "call:ice_candidate":
          if (event.callId === callIdRef.current) {
            void meshRef.current?.handleCandidate(event.fromUserId, event.candidate).catch(() => undefined);
          }
          return;
        case "call:error":
          if (event.callId && event.callId === callIdRef.current) {
            if (pendingAcceptRef.current === event.callId) {
              // Our join was refused (call ended, full, another device…).
              finishCall(null, { title: "Couldn't join the call", detail: event.message, canRetry: false });
              callIdRef.current = null;
            } else {
              setNotice(event.message);
            }
          }
          return;
        default:
          return;
      }
    });
  }, [subscribe, send, myId, finishCall, updateIncoming, updatePhase]);

  // Best effort: leave the call if the tab is closed mid-call.
  useEffect(() => {
    const onUnload = () => {
      const callId = callIdRef.current;
      if (callId && (phaseRef.current === "outgoing" || phaseRef.current === "active")) send({ type: "call:end", callId });
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [send]);

  // Stop the camera/mic if the provider unmounts (e.g. logout).
  useEffect(() => () => {
    if (endedTimerRef.current) clearTimeout(endedTimerRef.current);
    meshRef.current?.closeAll();
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  const value: CallContextValue = {
    phase,
    call,
    incomingCall,
    localStream,
    remoteStreams,
    peerStates,
    micEnabled,
    cameraEnabled,
    remoteRinging,
    notice,
    error,
    endSummary,
    isStarting,
    isBusy: phase === "outgoing" || phase === "active" || isStarting,
    startCall,
    acceptIncoming,
    declineIncoming,
    joinCall,
    hangUp,
    toggleMic,
    toggleCamera,
    retry,
    dismiss,
  };

  return <CallContext.Provider value={value}>{children}</CallContext.Provider>;
}

export function useCalls(): CallContextValue {
  const ctx = useContext(CallContext);
  if (!ctx) throw new Error("useCalls must be used within a CallProvider");
  return ctx;
}

/** For components that also render outside the app shell (and in older tests): calling UI is simply hidden. */
export function useOptionalCalls(): CallContextValue | undefined {
  return useContext(CallContext);
}
