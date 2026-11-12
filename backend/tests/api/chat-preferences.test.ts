import type { Express } from "express";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import type { Container } from "../../src/container";
import type { DatabaseClient } from "../../src/db/pool";
import { MAX_PINNED_CHATS } from "../../src/modules/conversations/conversations.service";
import { as } from "../helpers/api";
import { FakeRealtimeGateway } from "../helpers/fakeRealtimeGateway";
import { createDirectConversation, createGroup, sendMessage } from "../helpers/fixtures";
import { createTestDb } from "../helpers/testDb";
import { signupTestUser, type TestUser } from "../helpers/testUser";

describe("Chat preferences API (pin / archive / mute)", () => {
  let app: Express;
  let db: DatabaseClient;
  let container: Container;
  let gateway: FakeRealtimeGateway;
  let alice: TestUser;
  let bob: TestUser;
  let eve: TestUser;
  let conversationId: string;

  const prefs = (user: TestUser, convId: string) => as(app, user).patch(`/api/v1/conversations/${convId}/preferences`);
  const listFor = async (user: TestUser) =>
    (await as(app, user).get("/api/v1/conversations")).body.conversations as Array<{
      id: string;
      pinned: boolean;
      archived: boolean;
      mutedUntil: string | null;
    }>;

  beforeEach(async () => {
    db = await createTestDb();
    ({ app, container } = createApp({ db }));
    gateway = new FakeRealtimeGateway();
    container.realtimeGatewayRef.current = gateway;
    alice = await signupTestUser(app, { displayName: "Alice", email: "alice@example.com" });
    bob = await signupTestUser(app, { displayName: "Bob", email: "bob@example.com" });
    eve = await signupTestUser(app, { displayName: "Eve", email: "eve@example.com" });
    conversationId = await createDirectConversation(app, alice, bob);
  });

  it("starts unpinned, unarchived and unmuted; changes are private to the user who made them", async () => {
    expect((await listFor(alice))[0]).toMatchObject({ pinned: false, archived: false, mutedUntil: null });

    const res = await prefs(alice, conversationId).send({ pinned: true, mute: "always" });
    expect(res.status).toBe(200);
    expect(res.body.preferences).toMatchObject({ pinned: true, archived: false });
    expect(new Date(res.body.preferences.mutedUntil).getUTCFullYear()).toBe(9999);

    expect((await listFor(alice))[0]).toMatchObject({ pinned: true, archived: false });
    expect((await listFor(bob))[0]).toMatchObject({ pinned: false, archived: false, mutedUntil: null });
  });

  it("archiving unpins, pinning unarchives, and mute durations are computed by the server", async () => {
    await prefs(alice, conversationId).send({ pinned: true });
    expect((await prefs(alice, conversationId).send({ archived: true })).body.preferences).toMatchObject({ pinned: false, archived: true });
    expect((await prefs(alice, conversationId).send({ pinned: true })).body.preferences).toMatchObject({ pinned: true, archived: false });

    const before = Date.now();
    const muted = (await prefs(alice, conversationId).send({ mute: "8h" })).body.preferences.mutedUntil as string;
    const hours = (new Date(muted).getTime() - before) / 3_600_000;
    expect(hours).toBeGreaterThan(7.99);
    expect(hours).toBeLessThan(8.01);
    expect((await prefs(alice, conversationId).send({ mute: "off" })).body.preferences.mutedUntil).toBeNull();
    expect((await prefs(alice, conversationId).send({ pinned: true, archived: true })).status).toBe(400);
  });

  it(`allows at most ${MAX_PINNED_CHATS} pinned chats`, async () => {
    const others = await Promise.all(
      Array.from({ length: MAX_PINNED_CHATS + 1 }, (_, i) => signupTestUser(app, { displayName: `U${i}`, email: `u${i}@example.com` }))
    );
    const ids = [];
    for (const other of others) ids.push(await createDirectConversation(app, alice, other));
    for (const id of ids.slice(0, MAX_PINNED_CHATS)) expect((await prefs(alice, id).send({ pinned: true })).status).toBe(200);

    const over = await prefs(alice, ids[MAX_PINNED_CHATS]!).send({ pinned: true });
    expect(over.status).toBe(400);
    expect(over.body.error.message).toBe(`You can pin up to ${MAX_PINNED_CHATS} chats`);
    // Re-pinning an already pinned chat isn't "another" pin.
    expect((await prefs(alice, ids[0]!).send({ pinned: true })).status).toBe(200);
  });

  it("refuses outsiders and former members (404) and validates the body", async () => {
    expect((await prefs(eve, conversationId).send({ pinned: true })).status).toBe(404);

    const { groupId, conversationId: group } = await createGroup(app, alice, [bob]);
    await as(app, bob).post(`/api/v1/groups/${groupId}/leave`);
    expect((await prefs(bob, group).send({ archived: true })).status).toBe(404);

    expect((await prefs(alice, conversationId).send({})).status).toBe(400);
    expect((await prefs(alice, conversationId).send({ mute: "forever" })).status).toBe(400);
    expect((await prefs(alice, conversationId).send({ pinned: "yes" })).status).toBe(400);
    expect((await prefs(alice, conversationId).send({ pinned: true, mutedUntil: "2030-01-01" })).status).toBe(400);
    expect((await as(app, alice).patch("/api/v1/conversations/not-a-uuid/preferences").send({ pinned: true })).status).toBe(400);
  });

  it("tells only your own devices", async () => {
    gateway.sentEvents.length = 0;
    await prefs(alice, conversationId).send({ archived: true });
    expect(gateway.sentEvents.map((e) => [e.userId, e.event.type])).toEqual([[alice.userId, "conversation:preferences"]]);
    expect(gateway.sentEvents[0]!.event).toMatchObject({ conversationId, pinned: false, archived: true, mutedUntil: null });
  });

  it("a muted chat doesn't create @mention notifications; unmuted it does", async () => {
    const { conversationId: group } = await createGroup(app, alice, [bob]);
    const mentionBob = (body: string) => sendMessage(app, alice, group, { body: `${body} @Bob`, mentionedUserIds: [bob.userId] });
    const mentionCount = async () =>
      ((await as(app, bob).get("/api/v1/notifications")).body.notifications as Array<{ type: string }>).filter((n) => n.type === "mention")
        .length;

    await prefs(bob, group).send({ mute: "1w" });
    expect((await mentionBob("muted")).status).toBe(201);
    expect(await mentionCount()).toBe(0);

    await prefs(bob, group).send({ mute: "off" });
    await mentionBob("unmuted");
    expect(await mentionCount()).toBe(1);
  });

  it("an expired mute reads as not muted", async () => {
    await db.query("UPDATE conversation_members SET muted_until = $1 WHERE conversation_id = $2 AND user_id = $3", [
      new Date(Date.now() - 60_000),
      conversationId,
      alice.userId,
    ]);
    expect((await listFor(alice))[0]!.mutedUntil).toBeNull();
  });
});
