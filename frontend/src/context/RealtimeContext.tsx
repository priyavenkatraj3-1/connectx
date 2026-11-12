import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { WS_BASE_URL } from "../services/apiClient";
import type { ClientEvent, ServerEvent } from "../types/realtime";
import { isTokenExpiring } from "../utils/jwt";
import { useAuth } from "./AuthContext";

type Listener = (event: ServerEvent) => void;

export interface RealtimeContextValue {
  /** Subscribes to every server event; returns an unsubscribe function. */
  subscribe(listener: Listener): () => void;
  /** Sends an event if the socket is open. Returns false if it couldn't be sent. */
  send(event: ClientEvent): boolean;
  /**
   * This tab's connection ID, sent to the server as `cid` and kept across
   * reconnects. Calls started from this tab are bound to it, so WebRTC
   * signaling reaches this tab only — not the user's other tabs/devices.
   */
  connectionId: string;
  /**
   * Called each time the socket opens again after an unexpected drop. Server
   * events sent while disconnected are not replayed, so views that depend on
   * them (chat list, open chat, status counts) refetch. Optional so test
   * fakes don't have to provide it.
   */
  onReconnect?(listener: () => void): () => void;
}

/** Exported so tests can provide a fake realtime channel. */
export const RealtimeContext = createContext<RealtimeContextValue | undefined>(undefined);

const RECONNECT_DELAY_MS = 2000;
/** Refresh before reconnecting if the access token expires within this window — the handshake would otherwise be refused. */
const TOKEN_EXPIRY_MARGIN_MS = 5000;
/** Back off when the refresh itself failed (offline, server unreachable) instead of retrying it every 2s. */
const REFRESH_FAILED_RETRY_MS = 10_000;

function generateConnectionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // RFC 4122 v4 fallback for older browsers.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** Close code the server uses when this connection's session was signed out (see backend ws.server.ts). */
const SESSION_REVOKED_CLOSE_CODE = 4401;

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { accessToken, sessionId, endLocalSession, refreshAccessToken } = useAuth();
  const socketRef = useRef<WebSocket | null>(null);
  const listenersRef = useRef(new Set<Listener>());
  const reconnectListenersRef = useRef(new Set<() => void>());
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The last socket closed unexpectedly; the next successful open is a reconnect. */
  const droppedRef = useRef(false);
  const refreshRef = useRef(refreshAccessToken);
  refreshRef.current = refreshAccessToken;
  const [connectionId] = useState(generateConnectionId);

  useEffect(() => {
    if (!accessToken) {
      socketRef.current?.close();
      socketRef.current = null;
      return;
    }

    let cancelled = false;

    function connect(token: string): void {
      const socket = new WebSocket(`${WS_BASE_URL}?token=${encodeURIComponent(token)}&cid=${connectionId}`);
      socketRef.current = socket;

      socket.onopen = () => {
        if (cancelled || !droppedRef.current) return;
        droppedRef.current = false;
        for (const listener of reconnectListenersRef.current) listener();
      };

      socket.onmessage = (messageEvent) => {
        try {
          const parsed = JSON.parse(messageEvent.data as string) as ServerEvent;
          for (const listener of listenersRef.current) listener(parsed);
        } catch {
          // Ignore malformed frames rather than crashing the realtime pipeline.
        }
      };

      socket.onclose = (closeEvent?: CloseEvent) => {
        if (cancelled) return;
        // Signed out from another device: don't reconnect with a dead token.
        if (closeEvent?.code === SESSION_REVOKED_CLOSE_CODE) return;
        droppedRef.current = true;
        reconnectTimerRef.current = setTimeout(() => void reconnect(token), RECONNECT_DELAY_MS);
      };
    }

    async function reconnect(token: string): Promise<void> {
      if (cancelled) return;
      if (!isTokenExpiring(token, TOKEN_EXPIRY_MARGIN_MS)) {
        connect(token);
        return;
      }
      // Reconnecting with an expired token would be refused forever (no
      // realtime events, no incoming calls) — refresh it first. A new token
      // re-runs this effect, whose cleanup cancels the retry below.
      const refreshed = await refreshRef.current();
      if (cancelled) return;
      reconnectTimerRef.current = setTimeout(() => void reconnect(refreshed ?? token), refreshed ? RECONNECT_DELAY_MS : REFRESH_FAILED_RETRY_MS);
    }

    if (isTokenExpiring(accessToken, TOKEN_EXPIRY_MARGIN_MS)) void reconnect(accessToken);
    else connect(accessToken);

    return () => {
      cancelled = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [accessToken, connectionId]);

  const onReconnect = useCallback((listener: () => void) => {
    reconnectListenersRef.current.add(listener);
    return () => {
      reconnectListenersRef.current.delete(listener);
    };
  }, []);

  const subscribe = useCallback((listener: Listener) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  // Phase 6: this device's session was signed out from another device.
  useEffect(
    () =>
      subscribe((event) => {
        if (event.type === "session:revoked" && sessionId && event.sessionId === sessionId) {
          endLocalSession("This device was signed out from another device.");
        }
      }),
    [subscribe, sessionId, endLocalSession]
  );

  const send = useCallback((event: ClientEvent) => {
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(event));
      return true;
    }
    return false;
  }, []);

  const value = useMemo(() => ({ subscribe, send, connectionId, onReconnect }), [subscribe, send, connectionId, onReconnect]);
  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtime(): RealtimeContextValue {
  const ctx = useContext(RealtimeContext);
  if (!ctx) {
    throw new Error("useRealtime must be used within a RealtimeProvider");
  }
  return ctx;
}
