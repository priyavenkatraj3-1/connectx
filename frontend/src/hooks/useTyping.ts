import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { RealtimeContext } from "../context/RealtimeContext";

/** While typing continues, "started typing" is re-sent this often (the server drops faster repeats). */
export const TYPING_RESEND_MS = 3000;
/** No keystroke for this long → "stopped typing". */
export const TYPING_IDLE_MS = 4000;
/** A typing state not refreshed for this long is dropped (covers a lost "stopped" event or a closed tab). */
export const TYPING_EXPIRY_MS = 6000;

/**
 * Tells the other members of `conversationId` when you start/stop typing.
 * Call `typed()` on every edit and `stop()` when the text is sent or cleared;
 * it also stops on idle, when the chat changes and on unmount. Works without
 * a realtime connection (does nothing).
 */
export function useTypingNotifier(conversationId: string) {
  const send = useContext(RealtimeContext)?.send;
  const sendRef = useRef(send);
  sendRef.current = send;
  const state = useRef<{ active: boolean; lastSentAt: number; idleTimer: ReturnType<typeof setTimeout> | null }>({
    active: false,
    lastSentAt: 0,
    idleTimer: null,
  });

  const stop = useCallback(() => {
    const s = state.current;
    if (s.idleTimer) clearTimeout(s.idleTimer);
    s.idleTimer = null;
    if (!s.active) return;
    s.active = false;
    s.lastSentAt = 0;
    sendRef.current?.({ type: "typing", conversationId, isTyping: false });
  }, [conversationId]);

  const typed = useCallback(() => {
    const s = state.current;
    const now = Date.now();
    if (!s.active || now - s.lastSentAt >= TYPING_RESEND_MS) {
      // Only counts as active if it was actually sent (socket open).
      if (sendRef.current?.({ type: "typing", conversationId, isTyping: true })) {
        s.active = true;
        s.lastSentAt = now;
      }
    }
    if (s.idleTimer) clearTimeout(s.idleTimer);
    s.idleTimer = setTimeout(stop, TYPING_IDLE_MS);
  }, [conversationId, stop]);

  // Switching chats or leaving the page ends typing in the previous chat.
  useEffect(() => stop, [stop]);

  return useMemo(() => ({ typed, stop }), [typed, stop]);
}

/**
 * IDs of the people currently typing in `conversationId` (never yourself).
 * Someone stops counting as typing when they say so, when their message
 * arrives, or after TYPING_EXPIRY_MS without a refresh.
 */
export function useTypingUsers(conversationId: string | undefined): string[] {
  const subscribe = useContext(RealtimeContext)?.subscribe;
  const [expiries, setExpiries] = useState<Record<string, number>>({});

  useEffect(() => {
    setExpiries({});
    if (!subscribe || !conversationId) return;
    return subscribe((event) => {
      if (event.type === "typing" && event.conversationId === conversationId) {
        setExpiries((current) => {
          const next = { ...current };
          if (event.isTyping) next[event.userId] = Date.now() + TYPING_EXPIRY_MS;
          else delete next[event.userId];
          return next;
        });
      } else if (event.type === "message:new" && event.conversationId === conversationId) {
        setExpiries((current) => {
          if (!(event.message.senderId in current)) return current;
          const next = { ...current };
          delete next[event.message.senderId];
          return next;
        });
      }
    });
  }, [subscribe, conversationId]);

  // Drop states that weren't refreshed in time.
  const ids = Object.keys(expiries);
  useEffect(() => {
    if (ids.length === 0) return;
    const soonest = Math.min(...Object.values(expiries));
    const timer = setTimeout(() => {
      const now = Date.now();
      setExpiries((current) => Object.fromEntries(Object.entries(current).filter(([, expiresAt]) => expiresAt > now)));
    }, Math.max(0, soonest - Date.now()) + 10);
    return () => clearTimeout(timer);
  }, [expiries, ids.length]);

  return ids;
}

/** "Grace is typing…", "Grace and Alan are typing…", "3 people are typing…". */
export function describeTyping(names: string[]): string | null {
  if (names.length === 0) return null;
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return `${names.length} people are typing…`;
}
