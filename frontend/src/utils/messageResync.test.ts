import { describe, expect, it } from "vitest";
import type { MessageDTO } from "../types/message";
import { reconcileLatestPage } from "./messageResync";

const BASE = Date.parse("2026-01-01T12:00:00Z");

function m(n: number, body = `message ${n}`): MessageDTO {
  return {
    id: `m${n}`,
    conversationId: "c1",
    senderId: "u2",
    contentType: "text",
    body,
    status: "sent",
    createdAt: new Date(BASE + n * 1000).toISOString(),
    editedAt: null,
  };
}
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => m(from + i));
const ids = (messages: MessageDTO[]) => messages.map((x) => x.id);

describe("reconcileLatestPage", () => {
  it("replaces everything when the page holds the whole conversation (drops messages deleted meanwhile)", () => {
    const result = reconcileLatestPage([m(1), m(2), m(3)], { items: [m(1), m(3), m(4)], hasMore: false });
    expect(ids(result.messages)).toEqual(["m1", "m3", "m4"]);
    expect(result.hasMore).toBe(false);
  });

  it("keeps older history that connects to the page and takes the page's copy of overlapping messages", () => {
    const edited = { ...m(50), body: "edited while away", status: "read" as const };
    const result = reconcileLatestPage(range(1, 50), { items: [...range(3, 49), edited, m(51), m(52)], hasMore: true });
    expect(ids(result.messages)).toEqual(ids(range(1, 52)));
    expect(result.messages[49]).toEqual(edited);
    expect(result.hasMore).toBeNull();
  });

  it("connects by time when the newest shown message was deleted while away", () => {
    const result = reconcileLatestPage(range(1, 50), { items: range(40, 49).concat(range(51, 90)), hasMore: true });
    expect(ids(result.messages)).toEqual(ids(range(1, 49).concat(range(51, 90))));
  });

  it("replaces the list when more than a page arrived, rather than leaving a hidden gap", () => {
    const result = reconcileLatestPage(range(1, 10), { items: range(60, 109), hasMore: true });
    expect(ids(result.messages)).toEqual(ids(range(60, 109)));
    expect(result.hasMore).toBe(true);
  });

  it("handles an empty chat on either side", () => {
    expect(reconcileLatestPage([], { items: range(1, 50), hasMore: true }).messages).toHaveLength(50);
    expect(reconcileLatestPage(range(1, 3), { items: [], hasMore: false })).toEqual({ messages: [], hasMore: false });
  });
});
