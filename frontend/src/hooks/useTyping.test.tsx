import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RealtimeContext } from "../context/RealtimeContext";
import { createFakeRealtime } from "../tests/fakeWebRtc";
import type { MessageDTO } from "../types/message";
import { describeTyping, TYPING_EXPIRY_MS, TYPING_IDLE_MS, TYPING_RESEND_MS, useTypingNotifier, useTypingUsers } from "./useTyping";

const CONV = "11111111-1111-4111-8111-aaaaaaaaaaaa";
const OTHER = "11111111-1111-4111-8111-bbbbbbbbbbbb";

function withRealtime(realtime: ReturnType<typeof createFakeRealtime>) {
  return ({ children }: { children: ReactNode }) => <RealtimeContext.Provider value={realtime.value}>{children}</RealtimeContext.Provider>;
}

const typingSent = (realtime: ReturnType<typeof createFakeRealtime>) =>
  realtime.sent.filter((e) => e.type === "typing").map((e) => (e.type === "typing" ? [e.conversationId, e.isTyping] : null));

describe("useTypingNotifier", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sends start once, refreshes while typing continues, and stops when idle", () => {
    const realtime = createFakeRealtime();
    const { result } = renderHook(() => useTypingNotifier(CONV), { wrapper: withRealtime(realtime) });

    act(() => result.current.typed());
    act(() => result.current.typed());
    expect(typingSent(realtime)).toEqual([[CONV, true]]);

    act(() => vi.advanceTimersByTime(TYPING_RESEND_MS));
    act(() => result.current.typed());
    expect(typingSent(realtime)).toEqual([[CONV, true], [CONV, true]]);

    act(() => vi.advanceTimersByTime(TYPING_IDLE_MS));
    expect(typingSent(realtime).at(-1)).toEqual([CONV, false]);
    act(() => vi.advanceTimersByTime(TYPING_IDLE_MS * 2));
    expect(typingSent(realtime)).toHaveLength(3); // only one stop
  });

  it("stop() sends a single stop, and only after a start", () => {
    const realtime = createFakeRealtime();
    const { result } = renderHook(() => useTypingNotifier(CONV), { wrapper: withRealtime(realtime) });
    act(() => result.current.stop());
    expect(typingSent(realtime)).toEqual([]);

    act(() => result.current.typed());
    act(() => result.current.stop());
    act(() => result.current.stop());
    expect(typingSent(realtime)).toEqual([
      [CONV, true],
      [CONV, false],
    ]);
  });

  it("stops in the previous chat when switching chats, and on unmount", () => {
    const realtime = createFakeRealtime();
    const { result, rerender, unmount } = renderHook(({ id }) => useTypingNotifier(id), {
      wrapper: withRealtime(realtime),
      initialProps: { id: CONV },
    });
    act(() => result.current.typed());
    rerender({ id: OTHER });
    act(() => result.current.typed());
    unmount();
    expect(typingSent(realtime)).toEqual([
      [CONV, true],
      [CONV, false],
      [OTHER, true],
      [OTHER, false],
    ]);
  });

  it("doesn't consider itself typing if the socket couldn't send (so it retries on the next keystroke)", () => {
    const realtime = createFakeRealtime();
    let online = false;
    const send = realtime.value.send;
    realtime.value.send = (event) => (online ? send(event) : false);
    const { result } = renderHook(() => useTypingNotifier(CONV), { wrapper: withRealtime(realtime) });

    act(() => result.current.typed());
    online = true;
    act(() => result.current.typed());
    expect(typingSent(realtime)).toEqual([[CONV, true]]);
  });
});

describe("useTypingUsers", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("tracks start/stop for this chat only and expires a state that isn't refreshed", () => {
    const realtime = createFakeRealtime();
    const { result } = renderHook(() => useTypingUsers(CONV), { wrapper: withRealtime(realtime) });

    realtime.emit({ type: "typing", conversationId: CONV, userId: "u2", isTyping: true });
    realtime.emit({ type: "typing", conversationId: OTHER, userId: "u3", isTyping: true });
    expect(result.current).toEqual(["u2"]);

    realtime.emit({ type: "typing", conversationId: CONV, userId: "u2", isTyping: false });
    expect(result.current).toEqual([]);

    realtime.emit({ type: "typing", conversationId: CONV, userId: "u2", isTyping: true });
    act(() => vi.advanceTimersByTime(TYPING_EXPIRY_MS + 20));
    expect(result.current).toEqual([]);
  });

  it("clears someone as soon as their message arrives, and resets when the chat changes", () => {
    const realtime = createFakeRealtime();
    const { result, rerender } = renderHook(({ id }) => useTypingUsers(id), {
      wrapper: withRealtime(realtime),
      initialProps: { id: CONV },
    });
    realtime.emit({ type: "typing", conversationId: CONV, userId: "u2", isTyping: true });
    realtime.emit({ type: "typing", conversationId: CONV, userId: "u3", isTyping: true });
    realtime.emit({ type: "message:new", conversationId: CONV, message: { id: "m1", senderId: "u2" } as MessageDTO });
    expect(result.current).toEqual(["u3"]);

    rerender({ id: OTHER });
    expect(result.current).toEqual([]);
  });
});

describe("describeTyping", () => {
  it("names one or two people and counts more", () => {
    expect(describeTyping([])).toBeNull();
    expect(describeTyping(["Grace"])).toBe("Grace is typing…");
    expect(describeTyping(["Grace", "Alan"])).toBe("Grace and Alan are typing…");
    expect(describeTyping(["A", "B", "C"])).toBe("3 people are typing…");
  });
});
