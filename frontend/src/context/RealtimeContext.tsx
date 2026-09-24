import { createContext, useCallback, useContext, useEffect, useRef, type ReactNode } from "react";
import { WS_BASE_URL } from "../services/apiClient";
import type { ClientEvent, ServerEvent } from "../types/realtime";
import { useAuth } from "./AuthContext";

type Listener = (event: ServerEvent) => void;

interface RealtimeContextValue {
  /** Subscribes to every server event; returns an unsubscribe function. */
  subscribe(listener: Listener): () => void;
  send(event: ClientEvent): void;
}

const RealtimeContext = createContext<RealtimeContextValue | undefined>(undefined);

const RECONNECT_DELAY_MS = 2000;

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { accessToken } = useAuth();
  const socketRef = useRef<WebSocket | null>(null);
  const listenersRef = useRef(new Set<Listener>());
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!accessToken) {
      socketRef.current?.close();
      socketRef.current = null;
      return;
    }

    let cancelled = false;

    function connect(token: string): void {
      const socket = new WebSocket(`${WS_BASE_URL}?token=${encodeURIComponent(token)}`);
      socketRef.current = socket;

      socket.onmessage = (messageEvent) => {
        try {
          const parsed = JSON.parse(messageEvent.data as string) as ServerEvent;
          for (const listener of listenersRef.current) listener(parsed);
        } catch {
          // Ignore malformed frames rather than crashing the realtime pipeline.
        }
      };

      socket.onclose = () => {
        if (cancelled) return;
        reconnectTimerRef.current = setTimeout(() => connect(token), RECONNECT_DELAY_MS);
      };
    }

    connect(accessToken);

    return () => {
      cancelled = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [accessToken]);

  const subscribe = useCallback((listener: Listener) => {
    listenersRef.current.add(listener);
    return () => listenersRef.current.delete(listener);
  }, []);

  const send = useCallback((event: ClientEvent) => {
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(event));
    }
  }, []);

  return <RealtimeContext.Provider value={{ subscribe, send }}>{children}</RealtimeContext.Provider>;
}

export function useRealtime(): RealtimeContextValue {
  const ctx = useContext(RealtimeContext);
  if (!ctx) {
    throw new Error("useRealtime must be used within a RealtimeProvider");
  }
  return ctx;
}
