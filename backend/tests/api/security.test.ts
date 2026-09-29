import type { Express } from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import type { Container } from "../../src/container";
import { env } from "../../src/config/env";
import { setLogLevel } from "../../src/utils/logger";
import { as, minutesFromNow } from "../helpers/api";
import { createDirectConversation, createGroup, SAMPLE_FILES, sendMessage, uploadFile } from "../helpers/fixtures";
import { MemoryStorageProvider } from "../helpers/memoryStorage";
import { ScriptedAIProvider } from "../helpers/scriptedAIProvider";
import { createTestDb } from "../helpers/testDb";
import { signupTestUser, type TestUser } from "../helpers/testUser";

/**
 * Phase 7 security regression suite: authentication edge cases, a
 * cross-module authorization matrix (an outsider against every kind of
 * private resource), and input-validation behavior that must never turn
 * into a 500 or leak internals.
 */

const DENIED = [403, 404];

function expectNoInternals(body: unknown): void {
  const text = JSON.stringify(body);
  expect(text).not.toMatch(/stack|at Object\.|node_modules|password_hash|SELECT |INSERT /i);
}

describe("Authentication hardening (Phase 7)", () => {
  let app: Express;

  beforeEach(async () => {
    app = createApp({ db: await createTestDb() }).app;
  });

  const signup = { email: "sec@example.com", password: "Passw0rd!", displayName: "Sec User" };

  it("gives the same answer for an unknown email and a wrong password", async () => {
    await request(app).post("/api/v1/auth/signup").send(signup);
    const unknown = await request(app).post("/api/v1/auth/login").send({ email: "nobody@example.com", password: "Passw0rd!" });
    const wrong = await request(app).post("/api/v1/auth/login").send({ email: signup.email, password: "Wr0ngPassword" });
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
  });

  it("never returns the password or its hash", async () => {
    const res = await request(app).post("/api/v1/auth/signup").send(signup);
    expect(JSON.stringify(res.body)).not.toContain(signup.password);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|password_hash|\$2[aby]\$/);
    const me = await request(app).get("/api/v1/users/me").set("Authorization", `Bearer ${res.body.tokens.accessToken}`);
    expect(JSON.stringify(me.body)).not.toMatch(/passwordHash|password_hash|\$2[aby]\$/);
  });

  it("answers concurrent duplicate signups with exactly one 201 and one 409", async () => {
    const [a, b] = await Promise.all([
      request(app).post("/api/v1/auth/signup").send(signup),
      request(app).post("/api/v1/auth/signup").send(signup),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
  });

  it("refreshes, then rejects garbage, access tokens and reused refresh tokens", async () => {
    const created = await request(app).post("/api/v1/auth/signup").send(signup);
    const { accessToken, refreshToken } = created.body.tokens as { accessToken: string; refreshToken: string };

    const refreshed = await request(app).post("/api/v1/auth/refresh").send({ refreshToken });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.tokens.refreshToken).not.toBe(refreshToken);

    expect((await request(app).post("/api/v1/auth/refresh").send({ refreshToken: "garbage" })).status).toBe(401);
    // An access token is signed with a different secret and is not a refresh token.
    expect((await request(app).post("/api/v1/auth/refresh").send({ refreshToken: accessToken })).status).toBe(401);
    expect((await request(app).post("/api/v1/auth/refresh").send({})).status).toBe(400);

    // Reusing the rotated-out token ends the session, so even the newest refresh token stops working.
    expect((await request(app).post("/api/v1/auth/refresh").send({ refreshToken })).status).toBe(401);
    expect((await request(app).post("/api/v1/auth/refresh").send({ refreshToken: refreshed.body.tokens.refreshToken })).status).toBe(401);
  });

  it("logout invalidates the access token immediately", async () => {
    const created = await request(app).post("/api/v1/auth/signup").send(signup);
    const token = created.body.tokens.accessToken as string;
    expect((await request(app).get("/api/v1/users/me").set("Authorization", `Bearer ${token}`)).status).toBe(200);
    expect((await request(app).post("/api/v1/auth/logout").set("Authorization", `Bearer ${token}`)).status).toBe(204);
    const after = await request(app).get("/api/v1/users/me").set("Authorization", `Bearer ${token}`);
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe("session_revoked");
    // Logging out twice (or with no token) is harmless.
    expect((await request(app).post("/api/v1/auth/logout").set("Authorization", `Bearer ${token}`)).status).toBe(204);
    expect((await request(app).post("/api/v1/auth/logout")).status).toBe(204);
  });

  it("rejects forged, unsigned, expired and malformed bearer tokens with 401", async () => {
    const created = await request(app).post("/api/v1/auth/signup").send(signup);
    const userId = created.body.user.id as string;
    const sid = created.body.session.id as string;

    const forged = jwt.sign({ userId, sid }, "not-the-server-secret");
    const unsigned = jwt.sign({ userId, sid }, "", { algorithm: "none" });
    const expired = jwt.sign({ userId, sid, exp: Math.floor(Date.now() / 1000) - 60 }, env.jwt.accessSecret);
    const wrongAlg = jwt.sign({ userId, sid }, env.jwt.accessSecret, { algorithm: "HS512" });

    for (const header of [`Bearer ${forged}`, `Bearer ${unsigned}`, `Bearer ${expired}`, `Bearer ${wrongAlg}`, "Bearer", "Basic abc", "Bearer a.b.c"]) {
      const res = await request(app).get("/api/v1/users/me").set("Authorization", header);
      expect(res.status, header).toBe(401);
      expectNoInternals(res.body);
    }
  });

  it("validates signup and login input", async () => {
    for (const body of [
      {},
      { ...signup, email: "not-an-email" },
      { ...signup, password: "alllowercase1" },
      { ...signup, password: "x".repeat(129) + "Aa1" },
      { ...signup, displayName: "" },
    ]) {
      expect((await request(app).post("/api/v1/auth/signup").send(body)).status).toBe(400);
    }
    expect((await request(app).post("/api/v1/auth/login").send({ email: signup.email })).status).toBe(400);
  });
});

describe("Input validation never becomes a 500 (Phase 7)", () => {
  let app: Express;
  let alice: TestUser;

  beforeAll(async () => {
    app = createApp({ db: await createTestDb() }).app;
    alice = await signupTestUser(app, { displayName: "Alice Valid" });
  });

  it("answers malformed JSON with a 400 error envelope", async () => {
    const res = await request(app)
      .post("/api/v1/auth/login")
      .set("Content-Type", "application/json")
      .send('{"email": "a@b.c", "password": ');
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBeTypeOf("string");
    expectNoInternals(res.body);
  });

  it("rejects an oversized JSON body with 413", async () => {
    const res = await request(app)
      .post("/api/v1/auth/login")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ email: "a@b.c", password: "x".repeat(1_100_000) }));
    expect(res.status).toBe(413);
  });

  it("rejects malformed IDs in paths with 400 on every conversation-scoped route", async () => {
    const paths: Array<["get" | "post", string]> = [
      ["get", "/api/v1/users/not-a-uuid"],
      ["get", "/api/v1/conversations/not-a-uuid"],
      ["get", "/api/v1/messages/not-a-uuid"],
      ["post", "/api/v1/messages/not-a-uuid"],
      ["post", "/api/v1/messages/not-a-uuid/read"],
      ["get", "/api/v1/groups/not-a-uuid"],
      ["get", "/api/v1/media/not-a-uuid"],
      ["get", "/api/v1/statuses/not-a-uuid"],
      ["get", "/api/v1/calls/not-a-uuid"],
      ["get", "/api/v1/tasks/not-a-uuid"],
      ["get", "/api/v1/notes/not-a-uuid"],
      ["delete", "/api/v1/sessions/not-a-uuid"] as unknown as ["get", string],
      ["post", "/api/v1/ai/messages/not-a-uuid/translate"],
    ];
    for (const [method, path] of paths) {
      const res = await (as(app, alice) as Record<string, (url: string) => request.Test>)[method]!(path).send({ body: "hi" });
      expect(res.status, `${method.toUpperCase()} ${path}`).toBe(400);
      expectNoInternals(res.body);
    }
  });

  it("rejects script-capable avatar URLs", async () => {
    for (const avatarUrl of ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "vbscript:msgbox(1)"]) {
      expect((await as(app, alice).patch("/api/v1/users/me").send({ avatarUrl })).status, avatarUrl).toBe(400);
    }
    expect((await as(app, alice).patch("/api/v1/users/me").send({ avatarUrl: "https://example.com/a.png" })).status).toBe(200);
  });

  it("rejects out-of-range pagination and enum values", async () => {
    const bob = await signupTestUser(app);
    const conversationId = await createDirectConversation(app, alice, bob);
    expect((await as(app, alice).get(`/api/v1/messages/${conversationId}?limit=100000`)).status).toBe(400);
    expect((await as(app, alice).get(`/api/v1/messages/${conversationId}?limit=-1`)).status).toBe(400);
    expect((await as(app, alice).get(`/api/v1/messages/${conversationId}?before=nope`)).status).toBe(400);
    expect((await as(app, alice).post("/api/v1/tasks").send({ title: "x", priority: "extreme" })).status).toBe(400);
    expect((await as(app, alice).post("/api/v1/tasks").send({ title: "x", dueAt: "20260-01-01T00:00:00Z" })).status).toBe(400);
    expect((await as(app, alice).post("/api/v1/tasks").send({ title: "x", timezone: "Mars/Olympus" })).status).toBe(400);
  });

  it("keeps a message within its length limit", async () => {
    const bob = await signupTestUser(app);
    const conversationId = await createDirectConversation(app, alice, bob);
    expect((await sendMessage(app, alice, conversationId, { body: "x".repeat(4001) })).status).toBe(400);
    expect((await sendMessage(app, alice, conversationId, { body: "   " })).status).toBe(400);
  });

  it("user search treats LIKE wildcards literally and never matches partial emails", async () => {
    await signupTestUser(app, { displayName: "Wildcard Target", email: "hidden.person@corp.example" });
    const percent = await as(app, alice).get("/api/v1/users/search?q=%25");
    expect(percent.status).toBe(200);
    expect(percent.body.results).toEqual([]);
    const underscore = await as(app, alice).get("/api/v1/users/search?q=_");
    expect(underscore.body.results).toEqual([]);

    // A fragment of someone's email must not reveal that the account exists.
    expect((await as(app, alice).get("/api/v1/users/search?q=hidden.person")).body.results).toEqual([]);
    expect((await as(app, alice).get("/api/v1/users/search?q=corp.example")).body.results).toEqual([]);
    // The full address (any case) still finds them, without exposing the email.
    const exact = await as(app, alice).get("/api/v1/users/search?q=Hidden.Person@corp.example");
    expect(exact.body.results).toHaveLength(1);
    expect(exact.body.results[0].displayName).toBe("Wildcard Target");
    expect(exact.body.results[0].email).toBeUndefined();
  });

  it("exposes a readiness probe that checks the database", async () => {
    const ready = await request(app).get("/health/ready");
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ status: "ready" });
  });
});

describe("Authorization matrix: an outsider against every private resource (Phase 7)", () => {
  let app: Express;
  let container: Container;
  let provider: ScriptedAIProvider;
  let alice: TestUser;
  let bob: TestUser;
  let carol: TestUser; // outsider: shares no conversation with alice + bob
  let directId: string;
  let groupId: string;
  let groupConversationId: string;
  let aliceMessageId: string;
  let attachmentId: string;

  beforeAll(async () => {
    provider = new ScriptedAIProvider();
    ({ app, container } = createApp({
      db: await createTestDb(),
      storage: new MemoryStorageProvider(),
      aiProvider: provider,
      aiOptions: { retryBaseDelayMs: 0, maxRetries: 0, rateLimitPerMinute: 1000, rateLimitPerDay: 1000 },
    }));
    alice = await signupTestUser(app, { displayName: "Alice M" });
    bob = await signupTestUser(app, { displayName: "Bob M" });
    carol = await signupTestUser(app, { displayName: "Carol M" });
    for (const user of [alice, bob, carol]) {
      await as(app, user).patch("/api/v1/ai/settings").send({ aiFeaturesEnabled: true, aiMemoryEnabled: true });
    }
    directId = await createDirectConversation(app, alice, bob);
    aliceMessageId = (await sendMessage(app, alice, directId, { body: "private plan for Friday" })).body.message.id as string;
    ({ groupId, conversationId: groupConversationId } = await createGroup(app, alice, [bob], "Private group"));
    attachmentId = (await uploadFile(app, alice, directId, "plan.pdf", SAMPLE_FILES.pdf)).body.attachment.id as string;
    await sendMessage(app, alice, directId, { attachmentId, body: "the plan" });
  });

  it("conversations and messages", async () => {
    const outsider = as(app, carol);
    expect((await outsider.get(`/api/v1/conversations/${directId}`)).status).toBe(403);
    expect((await outsider.get(`/api/v1/messages/${directId}`)).status).toBe(403);
    expect((await outsider.post(`/api/v1/messages/${directId}`).send({ body: "let me in" })).status).toBe(403);
    expect((await outsider.post(`/api/v1/messages/${directId}/read`).send({ upToMessageId: aliceMessageId })).status).toBe(403);
    expect(DENIED).toContain((await outsider.patch(`/api/v1/messages/${directId}/${aliceMessageId}`).send({ body: "edited" })).status);
    expect(DENIED).toContain((await outsider.delete(`/api/v1/messages/${directId}/${aliceMessageId}`)).status);
    // A member still can't edit or delete someone else's message.
    expect((await as(app, bob).patch(`/api/v1/messages/${directId}/${aliceMessageId}`).send({ body: "edited" })).status).toBe(403);
    expect((await as(app, bob).delete(`/api/v1/messages/${directId}/${aliceMessageId}`)).status).toBe(403);
    // The conversation never shows up in the outsider's list.
    const list = await outsider.get("/api/v1/conversations");
    expect(JSON.stringify(list.body)).not.toContain(directId);
  });

  it("groups: membership and roles", async () => {
    const outsider = as(app, carol);
    expect(DENIED).toContain((await outsider.get(`/api/v1/groups/${groupId}`)).status);
    expect(DENIED).toContain((await outsider.get(`/api/v1/groups/${groupId}/members`)).status);
    expect(DENIED).toContain((await outsider.post(`/api/v1/groups/${groupId}/members`).send({ userIds: [carol.userId] })).status);
    expect(DENIED).toContain((await outsider.patch(`/api/v1/groups/${groupId}`).send({ name: "Hijacked" })).status);
    // A plain member can't remove the owner or promote themselves.
    expect((await as(app, bob).delete(`/api/v1/groups/${groupId}/members/${alice.userId}`)).status).toBe(403);
    expect((await as(app, bob).patch(`/api/v1/groups/${groupId}/members/${bob.userId}/role`).send({ role: "admin" })).status).toBe(403);
    expect((await outsider.get(`/api/v1/messages/${groupConversationId}`)).status).toBe(403);
  });

  it("media: metadata, bytes and deletion", async () => {
    const outsider = as(app, carol);
    expect(DENIED).toContain((await outsider.get(`/api/v1/media/${attachmentId}`)).status);
    const content = await outsider.get(`/api/v1/media/${attachmentId}/content`);
    expect(DENIED).toContain(content.status);
    expect(content.body).not.toBeInstanceOf(Buffer);
    expect(DENIED).toContain((await outsider.delete(`/api/v1/media/${attachmentId}`)).status);
    // Uploading into someone else's conversation is refused too.
    expect((await uploadFile(app, carol, directId, "x.pdf", SAMPLE_FILES.pdf)).status).toBe(403);
  });

  it("statuses: privacy and viewer lists", async () => {
    const created = await as(app, alice)
      .post("/api/v1/statuses")
      .send({ type: "text", text: "only for Bob", privacy: { visibility: "selected", userIds: [bob.userId] } });
    expect(created.status).toBe(201);
    const statusId = created.body.status?.id ?? created.body.id;
    expect(statusId).toBeTypeOf("string");

    expect((await as(app, carol).get(`/api/v1/statuses/${statusId}`)).status).toBe(404);
    expect((await as(app, carol).post(`/api/v1/statuses/${statusId}/view`)).status).toBe(404);
    expect((await as(app, carol).get(`/api/v1/statuses/${statusId}/viewers`)).status).toBe(404);
    expect(JSON.stringify((await as(app, carol).get("/api/v1/statuses")).body)).not.toContain(statusId);
    // Bob may see it, but not who else viewed it.
    expect((await as(app, bob).get(`/api/v1/statuses/${statusId}`)).status).toBe(200);
    expect((await as(app, bob).get(`/api/v1/statuses/${statusId}/viewers`)).status).toBe(403);
    expect((await as(app, bob).delete(`/api/v1/statuses/${statusId}`)).status).toBe(403);
  });

  it("AI: context retrieval and memory are authorization-filtered", async () => {
    const callsBefore = provider.calls.length;
    const ask = await as(app, carol).post("/api/v1/ai/ask").send({ question: "What is the plan for Friday?", conversationIds: [directId] });
    expect(ask.status).toBe(403);
    expect(DENIED).toContain((await as(app, carol).post(`/api/v1/ai/messages/${aliceMessageId}/translate`).send({ targetLanguage: "es" })).status);
    expect(DENIED).toContain((await as(app, carol).post(`/api/v1/ai/conversations/${directId}/actions/extract`).send({})).status);
    // Nothing about the private chat was sent to the provider.
    expect(provider.calls.length).toBe(callsBefore);

    const memory = await as(app, alice).post("/api/v1/ai/memories").send({ type: "fact", content: "Alice's private fact" });
    expect(memory.status).toBe(201);
    expect(DENIED).toContain((await as(app, carol).delete(`/api/v1/ai/memories/${memory.body.memory.id}`)).status);
    expect(JSON.stringify((await as(app, carol).get("/api/v1/ai/memories")).body)).not.toContain("Alice's private fact");
    expect(JSON.stringify((await as(app, alice).get("/api/v1/ai/memories")).body)).toContain("Alice's private fact");
  });

  it("tasks, reminders, events, notes, to-dos and scheduled messages", async () => {
    const task = await as(app, alice).post("/api/v1/tasks").send({ title: "Alice's task" });
    const reminder = await as(app, alice).post("/api/v1/reminders").send({ title: "Alice's reminder", remindAt: minutesFromNow(60) });
    const event = await as(app, alice).post("/api/v1/events").send({ title: "Alice's event", startsAt: minutesFromNow(60) });
    const note = await as(app, alice).post("/api/v1/notes").send({ conversationId: directId, title: "Plan", content: "secret" });
    const list = await as(app, alice).post("/api/v1/todo-lists").send({ conversationId: directId, title: "Groceries" });
    for (const res of [task, reminder, event, note, list]) expect(res.status, JSON.stringify(res.body)).toBe(201);

    const outsider = as(app, carol);
    expect(DENIED).toContain((await outsider.get(`/api/v1/tasks/${task.body.task.id}`)).status);
    expect(DENIED).toContain((await outsider.patch(`/api/v1/tasks/${task.body.task.id}`).send({ title: "mine" })).status);
    expect(DENIED).toContain((await outsider.delete(`/api/v1/tasks/${task.body.task.id}`)).status);
    expect(DENIED).toContain((await outsider.patch(`/api/v1/reminders/${reminder.body.reminder.id}`).send({ title: "mine" })).status);
    expect(DENIED).toContain((await outsider.get(`/api/v1/events/${event.body.event.id}`)).status);
    expect(DENIED).toContain((await outsider.get(`/api/v1/notes/${note.body.note.id}`)).status);
    expect(DENIED).toContain((await outsider.patch(`/api/v1/notes/${note.body.note.id}`).send({ content: "overwritten" })).status);
    expect(DENIED).toContain((await outsider.get(`/api/v1/notes?conversationId=${directId}`)).status);
    expect(DENIED).toContain((await outsider.get(`/api/v1/todo-lists/${list.body.list.id}`)).status);
    expect(DENIED).toContain((await outsider.post(`/api/v1/todo-lists/${list.body.list.id}/items`).send({ title: "x" })).status);
    expect(DENIED).toContain(
      (await outsider.post("/api/v1/scheduled-messages").send({ conversationId: directId, body: "later", scheduledFor: minutesFromNow(30) })).status
    );
    // The outsider's own lists don't include anything of Alice's.
    const tasks = await outsider.get("/api/v1/tasks");
    expect(JSON.stringify(tasks.body)).not.toContain("Alice's task");
  });

  it("devices and sessions are account-scoped", async () => {
    const sessions = await as(app, alice).get("/api/v1/sessions");
    const aliceSessionId = sessions.body.sessions[0].id as string;
    expect((await as(app, carol).delete(`/api/v1/sessions/${aliceSessionId}`)).status).toBe(404);
    expect((await as(app, carol).patch(`/api/v1/sessions/${aliceSessionId}`).send({ deviceName: "pwned" })).status).toBe(404);
    // Alice's session still works.
    expect((await as(app, alice).get("/api/v1/users/me")).status).toBe(200);
    // No token material is ever listed.
    expect(JSON.stringify(sessions.body)).not.toMatch(/token|hash/i);
  });

  it("calls: an outsider can't start, see or end a call in someone else's conversation", async () => {
    const start = await as(app, carol)
      .post("/api/v1/calls")
      .send({ conversationId: directId, media: "voice", connectionId: "00000000-0000-4000-8000-000000000000" });
    expect(start.status).toBe(403);
    expect((await as(app, carol).get(`/api/v1/calls/active?conversationId=${directId}`)).status).toBe(403);
    expect((await as(app, carol).get(`/api/v1/calls?conversationId=${directId}`)).status).toBe(403);
    // Unused, but keeps the container referenced for readers of this test.
    expect(container.callsService).toBeDefined();
  });
});

describe("Scheduler reliability (Phase 7)", () => {
  it("one failing notification doesn't stop the rest of the batch, and nothing fires twice", async () => {
    const { app, container } = createApp({ db: await createTestDb() });
    const alice = await signupTestUser(app);
    const first = await as(app, alice).post("/api/v1/reminders").send({ title: "First", remindAt: minutesFromNow(1) });
    const second = await as(app, alice).post("/api/v1/reminders").send({ title: "Second", remindAt: minutesFromNow(2) });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const notifications = container.notificationsService;
    const original = notifications.notify.bind(notifications);
    let failures = 0;
    notifications.notify = async (input) => {
      if (input.body === "First") {
        failures += 1;
        throw new Error("simulated notification failure");
      }
      return original(input);
    };

    const later = new Date(Date.now() + 5 * 60_000);
    setLogLevel("silent"); // the simulated failure is logged by design
    const result = await container.schedulerService.tick(later);
    setLogLevel("error");
    expect(result?.remindersFired).toBe(2);
    expect(failures).toBe(1);

    const list = await as(app, alice).get("/api/v1/notifications");
    const titles = (list.body.notifications as Array<{ body: string }>).map((n) => n.body);
    expect(titles).toContain("Second");

    // A second tick finds nothing left to fire.
    const again = await container.schedulerService.tick(later);
    expect(again?.remindersFired).toBe(0);
    notifications.notify = original;
  });
});
