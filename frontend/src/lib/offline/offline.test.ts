import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, NetworkError } from "../../services/apiClient";
import { messageService } from "../../services/messageService";
import { classifySendError } from "../../context/OfflineContext";
import type { MessageDTO } from "../../types/message";
import { CACHED_MESSAGES_PER_CONVERSATION, OfflineCache } from "./cache";
import { MAX_AUTO_ATTEMPTS, Outbox, type OutboxItem, type SendOutcome } from "./outbox";
import { clearOfflineDataFor, MemoryStore, purgeOfflineDataExcept, storeForUser } from "./storage";

function message(id: string, conversationId = "conv-1"): MessageDTO {
  return { id, conversationId, senderId: "u1", contentType: "text", body: `body ${id}`, status: "sent", createdAt: new Date().toISOString(), editedAt: null };
}

describe("Outbox (offline queue)", () => {
  let store: MemoryStore;
  let outbox: Outbox<MessageDTO>;

  beforeEach(() => {
    store = new MemoryStore();
    outbox = new Outbox<MessageDTO>(store);
  });

  it("sends queued items and removes them once confirmed", async () => {
    await outbox.enqueue({ clientMessageId: "c1", conversationId: "conv-1", body: "hello" });
    const onSent = vi.fn();
    const sent = await outbox.flush(async () => ({ kind: "sent", message: message("m1") }), onSent);
    expect(sent).toBe(1);
    expect(onSent).toHaveBeenCalledWith(expect.objectContaining({ clientMessageId: "c1" }), expect.objectContaining({ id: "m1" }));
    expect(outbox.snapshot()).toHaveLength(0);
  });

  it("keeps an item pending (same idempotency key) on a network failure, then succeeds later", async () => {
    await outbox.enqueue({ clientMessageId: "c1", conversationId: "conv-1", body: "hello" });
    const keys: string[] = [];
    await outbox.flush(async (item) => {
      keys.push(item.clientMessageId);
      return { kind: "retry", error: "offline" };
    });
    expect(outbox.snapshot()[0]).toMatchObject({ state: "pending", attempts: 1 });

    await outbox.flush(async (item) => {
      keys.push(item.clientMessageId);
      return { kind: "sent", message: message("m1") };
    });
    expect(keys).toEqual(["c1", "c1"]);
    expect(outbox.snapshot()).toHaveLength(0);
  });

  it("marks a rejected item failed and lets the user retry it", async () => {
    await outbox.enqueue({ clientMessageId: "c1", conversationId: "conv-1", body: "hello" });
    await outbox.flush(async () => ({ kind: "rejected", error: "You do not have access" }));
    expect(outbox.snapshot()[0]).toMatchObject({ state: "failed", error: "You do not have access" });

    // Failed items are not retried automatically…
    const send = vi.fn(async (): Promise<SendOutcome<MessageDTO>> => ({ kind: "sent", message: message("m1") }));
    await outbox.flush(send);
    expect(send).not.toHaveBeenCalled();
    // …only after an explicit retry.
    await outbox.markPending("c1");
    await outbox.flush(send);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("gives up automatically after too many transient failures", async () => {
    await outbox.enqueue({ clientMessageId: "c1", conversationId: "conv-1", body: "x" });
    for (let i = 0; i < MAX_AUTO_ATTEMPTS; i += 1) await outbox.flush(async () => ({ kind: "retry", error: "offline" }));
    expect(outbox.snapshot()[0]!.state).toBe("failed");
  });

  it("prevents duplicate sends: same key enqueued twice, and concurrent flushes", async () => {
    await outbox.enqueue({ clientMessageId: "c1", conversationId: "conv-1", body: "hello" });
    await outbox.enqueue({ clientMessageId: "c1", conversationId: "conv-1", body: "hello" });
    expect(outbox.snapshot()).toHaveLength(1);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const send = vi.fn(async (): Promise<SendOutcome<MessageDTO>> => {
      await gate;
      return { kind: "sent", message: message("m1") };
    });
    const first = outbox.flush(send);
    const second = outbox.flush(send);
    release();
    await Promise.all([first, second]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("preserves per-conversation order: a stuck message holds back later ones in that chat only", async () => {
    await outbox.enqueue({ clientMessageId: "a1", conversationId: "A", body: "first", createdAt: "2026-01-01T00:00:01Z" });
    await outbox.enqueue({ clientMessageId: "a2", conversationId: "A", body: "second", createdAt: "2026-01-01T00:00:02Z" });
    await outbox.enqueue({ clientMessageId: "b1", conversationId: "B", body: "other chat", createdAt: "2026-01-01T00:00:03Z" });
    const attempted: string[] = [];
    await outbox.flush(async (item: OutboxItem) => {
      attempted.push(item.clientMessageId);
      return item.clientMessageId === "a1" ? { kind: "retry", error: "offline" } : { kind: "sent", message: message(item.clientMessageId) };
    });
    expect(attempted).toEqual(["a1", "b1"]);
    expect(outbox.snapshot().map((i) => i.clientMessageId)).toEqual(["a1", "a2"]);
  });

  it("persists across reloads and resets interrupted 'sending' items to pending", async () => {
    await outbox.enqueue({ clientMessageId: "c1", conversationId: "conv-1", body: "hello" });
    const items = await store.get<OutboxItem[]>("outbox");
    await store.set("outbox", items!.map((item) => ({ ...item, state: "sending" })));

    const reloaded = new Outbox<MessageDTO>(store);
    expect((await reloaded.load())[0]).toMatchObject({ clientMessageId: "c1", state: "pending", body: "hello" });
  });
});

describe("send classification", () => {
  it("retries network errors and server errors, gives up on client errors", () => {
    expect(classifySendError(new NetworkError()).kind).toBe("retry");
    expect(classifySendError(new ApiError("boom", 503)).kind).toBe("retry");
    expect(classifySendError(new ApiError("slow down", 429)).kind).toBe("retry");
    expect(classifySendError(new ApiError("You do not have access to this conversation", 403)).kind).toBe("rejected");
    expect(classifySendError(new ApiError("Validation failed", 400)).kind).toBe("rejected");
  });
});

describe("offline storage isolation", () => {
  beforeEach(() => localStorage.clear());

  it("namespaces data per user and never lets one account read another's", async () => {
    await storeForUser("alice").set("conversations", { secret: "alice's chats" });
    expect(await storeForUser("bob").get("conversations")).toBeNull();
    expect(await storeForUser("alice").get("conversations")).toEqual({ secret: "alice's chats" });
  });

  it("purges other accounts' data at sign-in and clears your own at sign-out, leaving unrelated keys alone", async () => {
    localStorage.setItem("connectx.auth", "keep-me");
    await storeForUser("alice").set("outbox", [1]);
    await storeForUser("bob").set("outbox", [2]);

    purgeOfflineDataExcept("bob");
    expect(await storeForUser("alice").get("outbox")).toBeNull();
    expect(await storeForUser("bob").get("outbox")).toEqual([2]);

    clearOfflineDataFor("bob");
    expect(await storeForUser("bob").get("outbox")).toBeNull();
    expect(localStorage.getItem("connectx.auth")).toBe("keep-me");
  });
});

describe("OfflineCache", () => {
  it("keeps only the most recent messages and drops chats that left the recent list", async () => {
    const cache = new OfflineCache(new MemoryStore());
    const many = Array.from({ length: CACHED_MESSAGES_PER_CONVERSATION + 10 }, (_, i) => message(`m${i}`));
    await cache.saveMessages("conv-1", many);
    const loaded = await cache.loadMessages("conv-1");
    expect(loaded!.items).toHaveLength(CACHED_MESSAGES_PER_CONVERSATION);
    expect(loaded!.items.at(-1)!.id).toBe(`m${CACHED_MESSAGES_PER_CONVERSATION + 9}`);

    await cache.saveMessages("gone", [message("x", "gone")]);
    await cache.saveConversations([
      { id: "conv-1", type: "direct", otherParticipant: null, group: null, lastMessage: null, unreadCount: 0, updatedAt: new Date().toISOString() },
    ] as never);
    expect(await cache.loadMessages("gone")).toBeNull();
    expect(await cache.loadMessages("conv-1")).not.toBeNull();
  });
});

describe("messageService.send idempotency key", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends a clientMessageId with every message and reuses a caller-provided one", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ message: message("m1") }), { status: 201 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await messageService.send("token", "conv-1", "hi");
    await messageService.send("token", "conv-1", "hi", { clientMessageId: "11111111-1111-4111-8111-111111111111" });
    const bodies = fetchMock.mock.calls.map((call) => JSON.parse((call as unknown as [string, RequestInit])[1].body as string));
    expect(bodies[0].clientMessageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(bodies[1].clientMessageId).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("reports a dropped connection as a NetworkError carrying the key, so a retry can't duplicate", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const error = await messageService.send("token", "conv-1", "hi").catch((err: unknown) => err);
    expect(error).toBeInstanceOf(NetworkError);
    expect((error as NetworkError).clientMessageId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
