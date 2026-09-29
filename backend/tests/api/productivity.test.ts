import type { Express } from "express";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import type { Container } from "../../src/container";
import { generateId } from "../../src/utils/id";
import { as, minutesFromNow } from "../helpers/api";
import { FakeRealtimeGateway } from "../helpers/fakeRealtimeGateway";
import { createDirectConversation, createGroup, sendMessage } from "../helpers/fixtures";
import { createTestDb } from "../helpers/testDb";
import { signupTestUser, type TestUser } from "../helpers/testUser";

describe("Tasks, reminders and events (Phase 6)", () => {
  let app: Express;
  let container: Container;
  let gateway: FakeRealtimeGateway;
  let alice: TestUser;
  let bob: TestUser;
  let carol: TestUser;
  let directId: string;
  let messageId: string;

  beforeEach(async () => {
    gateway = new FakeRealtimeGateway();
    ({ app, container } = createApp({ db: await createTestDb(), realtimeGateway: gateway }));
    alice = await signupTestUser(app, { displayName: "Alice" });
    bob = await signupTestUser(app, { displayName: "Bob" });
    carol = await signupTestUser(app, { displayName: "Carol" });
    directId = await createDirectConversation(app, alice, bob);
    messageId = (await sendMessage(app, bob, directId, { body: "Please send the Q3 report by Friday" })).body.message.id;
  });

  describe("task CRUD", () => {
    it("creates, reads, updates, completes, reopens and deletes a task", async () => {
      const created = await as(app, alice)
        .post("/api/v1/tasks")
        .send({ title: "Send Q3 report", priority: "high", dueAt: "2030-01-10T17:00:00Z", description: "numbers" });
      expect(created.status).toBe(201);
      const task = created.body.task;
      expect(task).toMatchObject({ title: "Send Q3 report", status: "todo", priority: "high", ownerId: alice.userId, completedAt: null });
      expect(task.dueAt).toBe("2030-01-10T17:00:00.000Z");

      const fetched = await as(app, alice).get(`/api/v1/tasks/${task.id}`);
      expect(fetched.body.task.description).toBe("numbers");

      const updated = await as(app, alice).patch(`/api/v1/tasks/${task.id}`).send({ status: "in_progress", title: "Send final Q3 report" });
      expect(updated.body.task).toMatchObject({ status: "in_progress", title: "Send final Q3 report" });

      const completed = await as(app, alice).post(`/api/v1/tasks/${task.id}/complete`);
      expect(completed.body.task.status).toBe("completed");
      expect(completed.body.task.completedAt).not.toBeNull();

      const reopened = await as(app, alice).post(`/api/v1/tasks/${task.id}/reopen`);
      expect(reopened.body.task).toMatchObject({ status: "todo", completedAt: null });

      expect((await as(app, alice).delete(`/api/v1/tasks/${task.id}`)).status).toBe(204);
      expect((await as(app, alice).get(`/api/v1/tasks/${task.id}`)).status).toBe(404);
      expect(gateway.eventsFor(alice.userId).some((e) => e.type === "task:deleted")).toBe(true);
    });

    it("validates input", async () => {
      expect((await as(app, alice).post("/api/v1/tasks").send({ title: "" })).status).toBe(400);
      expect((await as(app, alice).post("/api/v1/tasks").send({ title: "x", priority: "extreme" })).status).toBe(400);
      expect((await as(app, alice).post("/api/v1/tasks").send({ title: "x", dueAt: "next friday" })).status).toBe(400);
      expect((await as(app, alice).post("/api/v1/tasks").send({ title: "x", dueAt: "2999-01-01T00:00:00Z" })).status).toBe(400);
      expect((await as(app, alice).post("/api/v1/tasks").send({ title: "x", reminderAt: "2020-01-01T00:00:00Z" })).status).toBe(400);
      expect((await as(app, alice).post("/api/v1/tasks").send({ title: "x", ownerId: bob.userId })).status).toBe(400);
      expect((await as(app, alice).get("/api/v1/tasks/not-a-uuid")).status).toBe(400);
    });

    it("filters and sorts the task list", async () => {
      const make = (body: Record<string, unknown>) => as(app, alice).post("/api/v1/tasks").send(body);
      await make({ title: "low later", priority: "low", dueAt: "2030-03-01T00:00:00Z" });
      await make({ title: "urgent soon", priority: "urgent", dueAt: "2030-01-01T00:00:00Z" });
      await make({ title: "no due date", priority: "medium" });
      const done = (await make({ title: "done one", priority: "high" })).body.task;
      await as(app, alice).post(`/api/v1/tasks/${done.id}/complete`);

      const byDue = await as(app, alice).get("/api/v1/tasks?status=open&sort=due");
      expect(byDue.body.tasks.map((t: { title: string }) => t.title)).toEqual(["urgent soon", "low later", "no due date"]);

      const byPriority = await as(app, alice).get("/api/v1/tasks?sort=priority");
      expect(byPriority.body.tasks[0].title).toBe("urgent soon");

      const completed = await as(app, alice).get("/api/v1/tasks?status=completed");
      expect(completed.body.tasks.map((t: { title: string }) => t.title)).toEqual(["done one"]);

      const search = await as(app, alice).get("/api/v1/tasks?q=later");
      expect(search.body.tasks).toHaveLength(1);

      const highOnly = await as(app, alice).get("/api/v1/tasks?priority=high");
      expect(highOnly.body.tasks.map((t: { title: string }) => t.title)).toEqual(["done one"]);
    });
  });

  describe("task authorization", () => {
    it("never shows or lets another user change a private task", async () => {
      const task = (await as(app, alice).post("/api/v1/tasks").send({ title: "private" })).body.task;
      expect((await as(app, bob).get(`/api/v1/tasks/${task.id}`)).status).toBe(404);
      expect((await as(app, bob).patch(`/api/v1/tasks/${task.id}`).send({ title: "hacked" })).status).toBe(404);
      expect((await as(app, bob).post(`/api/v1/tasks/${task.id}/complete`)).status).toBe(404);
      expect((await as(app, bob).delete(`/api/v1/tasks/${task.id}`)).status).toBe(404);
      expect((await as(app, bob).get("/api/v1/tasks")).body.tasks).toHaveLength(0);
      expect(gateway.eventsFor(bob.userId).filter((e) => e.type.startsWith("task:"))).toHaveLength(0);
    });

    it("requires authentication", async () => {
      const res = await (await import("supertest")).default(app).get("/api/v1/tasks");
      expect(res.status).toBe(401);
    });

    it("lets an assignee (a member of the source conversation) see the task and change only its status", async () => {
      const created = await as(app, alice)
        .post("/api/v1/tasks")
        .send({ title: "Review deck", sourceConversationId: directId, assigneeId: bob.userId });
      expect(created.status).toBe(201);
      const task = created.body.task;
      expect(task.assignee).toEqual({ id: bob.userId, displayName: "Bob" });

      expect((await as(app, bob).get("/api/v1/tasks?scope=assigned")).body.tasks).toHaveLength(1);
      expect((await as(app, bob).post(`/api/v1/tasks/${task.id}/complete`)).body.task.status).toBe("completed");
      expect((await as(app, bob).patch(`/api/v1/tasks/${task.id}`).send({ title: "renamed" })).status).toBe(403);
      expect((await as(app, bob).delete(`/api/v1/tasks/${task.id}`)).status).toBe(403);
      expect(gateway.eventsFor(bob.userId).some((e) => e.type === "notification:new")).toBe(true);
    });

    it("refuses to assign a task to someone outside the conversation", async () => {
      const res = await as(app, alice).post("/api/v1/tasks").send({ title: "x", sourceConversationId: directId, assigneeId: carol.userId });
      expect(res.status).toBe(400);
      const unlinked = await as(app, alice).post("/api/v1/tasks").send({ title: "x", assigneeId: bob.userId });
      expect(unlinked.status).toBe(400);
    });
  });

  describe("chat → task / reminder / event", () => {
    it("creates a task from a message, keeping the message untouched and referencing it", async () => {
      const res = await as(app, alice).post("/api/v1/tasks").send({ title: "Send the Q3 report", sourceMessageId: messageId });
      expect(res.status).toBe(201);
      expect(res.body.task.source).toMatchObject({ conversationId: directId, messageId, messageExcerpt: "Please send the Q3 report by Friday" });

      const messages = await as(app, alice).get(`/api/v1/messages/${directId}`);
      expect(messages.body.items[0]).toMatchObject({ id: messageId, body: "Please send the Q3 report by Friday", editedAt: null });
    });

    it("refuses a source message the user can't read", async () => {
      const res = await as(app, carol).post("/api/v1/tasks").send({ title: "steal", sourceMessageId: messageId });
      expect(res.status).toBe(404);
      const conv = await as(app, carol).post("/api/v1/reminders").send({ title: "x", remindAt: minutesFromNow(30), sourceConversationId: directId });
      expect(conv.status).toBe(403);
    });

    it("hides the source excerpt once the message is deleted", async () => {
      const task = (await as(app, alice).post("/api/v1/tasks").send({ title: "t", sourceMessageId: messageId })).body.task;
      await as(app, bob).delete(`/api/v1/messages/${directId}/${messageId}`);
      const fetched = await as(app, alice).get(`/api/v1/tasks/${task.id}`);
      expect(fetched.body.task.source.messageExcerpt).toBeNull();
    });

    async function insertSuggestion(userId: string, type = "task"): Promise<string> {
      const id = generateId();
      await container.db.query(
        `INSERT INTO ai_actions (id, user_id, conversation_id, source_message_id, type, title, status)
         VALUES ($1, $2, $3, $4, $5, 'Send the Q3 report', 'suggested')`,
        [id, userId, directId, messageId, type]
      );
      return id;
    }

    it("turns an AI suggestion into a task only on explicit request, exactly once", async () => {
      const actionId = await insertSuggestion(alice.userId);
      // Nothing exists until the user asks.
      expect((await as(app, alice).get("/api/v1/tasks")).body.tasks).toHaveLength(0);

      const res = await as(app, alice).post("/api/v1/tasks").send({ title: "Send the Q3 report (edited)", sourceActionId: actionId });
      expect(res.status).toBe(201);
      expect(res.body.task.source).toMatchObject({ actionId, messageId, conversationId: directId });

      const actions = await as(app, alice).get("/api/v1/ai/actions");
      expect(actions.body.actions[0]).toMatchObject({ id: actionId, status: "confirmed", convertedTo: "task", convertedId: res.body.task.id });

      const again = await as(app, alice).post("/api/v1/reminders").send({ title: "again", remindAt: minutesFromNow(10), sourceActionId: actionId });
      expect(again.status).toBe(409);
    });

    it("won't convert a dismissed suggestion or someone else's suggestion", async () => {
      const dismissed = await insertSuggestion(alice.userId);
      await as(app, alice).post(`/api/v1/ai/actions/${dismissed}/dismiss`);
      expect((await as(app, alice).post("/api/v1/tasks").send({ title: "x", sourceActionId: dismissed })).status).toBe(409);

      const bobs = await insertSuggestion(bob.userId);
      expect((await as(app, alice).post("/api/v1/events").send({ title: "x", startsAt: minutesFromNow(60), sourceActionId: bobs })).status).toBe(404);
    });
  });

  describe("reminders", () => {
    it("creates, reschedules, completes, dismisses and deletes reminders", async () => {
      const created = await as(app, alice).post("/api/v1/reminders").send({ title: "Call mum", remindAt: minutesFromNow(30), sourceMessageId: messageId });
      expect(created.status).toBe(201);
      const reminder = created.body.reminder;
      expect(reminder).toMatchObject({ status: "pending", title: "Call mum" });
      expect(reminder.source.messageId).toBe(messageId);

      const later = minutesFromNow(120);
      const rescheduled = await as(app, alice).patch(`/api/v1/reminders/${reminder.id}`).send({ remindAt: later });
      expect(rescheduled.body.reminder.remindAt).toBe(later);

      expect((await as(app, alice).post(`/api/v1/reminders/${reminder.id}/complete`)).body.reminder.status).toBe("completed");
      // Rescheduling brings a finished reminder back to pending.
      expect((await as(app, alice).patch(`/api/v1/reminders/${reminder.id}`).send({ remindAt: later })).body.reminder.status).toBe("pending");
      expect((await as(app, alice).post(`/api/v1/reminders/${reminder.id}/dismiss`)).body.reminder.status).toBe("dismissed");

      expect((await as(app, alice).get("/api/v1/reminders?status=active")).body.reminders).toHaveLength(0);
      expect((await as(app, alice).delete(`/api/v1/reminders/${reminder.id}`)).status).toBe(204);
    });

    it("rejects reminders in the past and keeps reminders private", async () => {
      expect((await as(app, alice).post("/api/v1/reminders").send({ title: "x", remindAt: "2020-01-01T00:00:00Z" })).status).toBe(400);
      expect((await as(app, alice).post("/api/v1/reminders").send({ title: "x" })).status).toBe(400);
      const reminder = (await as(app, alice).post("/api/v1/reminders").send({ title: "x", remindAt: minutesFromNow(5) })).body.reminder;
      expect((await as(app, bob).patch(`/api/v1/reminders/${reminder.id}`).send({ title: "y" })).status).toBe(404);
      expect((await as(app, bob).get("/api/v1/reminders")).body.reminders).toHaveLength(0);
    });

    it("keeps a task's reminder in step with the task", async () => {
      const task = (await as(app, alice).post("/api/v1/tasks").send({ title: "Pay rent", reminderAt: minutesFromNow(60) })).body.task;
      let reminders = (await as(app, alice).get("/api/v1/reminders")).body.reminders;
      expect(reminders).toHaveLength(1);
      expect(reminders[0]).toMatchObject({ taskId: task.id, title: "Pay rent", status: "pending" });

      await as(app, alice).patch(`/api/v1/tasks/${task.id}`).send({ title: "Pay the rent" });
      reminders = (await as(app, alice).get("/api/v1/reminders")).body.reminders;
      expect(reminders[0].title).toBe("Pay the rent");

      await as(app, alice).post(`/api/v1/tasks/${task.id}/complete`);
      expect((await as(app, alice).get("/api/v1/reminders")).body.reminders[0].status).toBe("completed");

      await as(app, alice).patch(`/api/v1/tasks/${task.id}`).send({ reminderAt: null });
      expect((await as(app, alice).get("/api/v1/reminders")).body.reminders).toHaveLength(0);
    });
  });

  describe("timezones", () => {
    it("interprets local times in the given timezone", async () => {
      const res = await as(app, alice)
        .post("/api/v1/tasks")
        .send({ title: "Standup", dueAtLocal: "2030-07-01T09:00", timezone: "Asia/Tokyo" });
      expect(res.status).toBe(201);
      expect(res.body.task).toMatchObject({ dueAt: "2030-07-01T00:00:00.000Z", timezone: "Asia/Tokyo" });
    });

    it("falls back to the user's preferred timezone, and requires one for local times", async () => {
      expect((await as(app, alice).post("/api/v1/tasks").send({ title: "x", dueAtLocal: "2030-07-01T09:00" })).status).toBe(400);
      await as(app, alice).patch("/api/v1/preferences").send({ timezone: "America/New_York" });
      const res = await as(app, alice).post("/api/v1/tasks").send({ title: "x", dueAtLocal: "2030-07-01T09:00" });
      expect(res.body.task.dueAt).toBe("2030-07-01T13:00:00.000Z");
    });

    it("rejects unknown timezones and non-existent local times", async () => {
      expect((await as(app, alice).post("/api/v1/tasks").send({ title: "x", dueAtLocal: "2030-07-01T09:00", timezone: "Moon/Base" })).status).toBe(400);
      expect((await as(app, alice).patch("/api/v1/preferences").send({ timezone: "Moon/Base" })).status).toBe(400);
      const gap = await as(app, alice).post("/api/v1/events").send({ title: "x", startsAtLocal: "2030-03-10T02:30", timezone: "America/New_York" });
      expect(gap.status).toBe(400);
    });
  });

  describe("events", () => {
    it("creates, lists by range, updates and deletes events", async () => {
      const created = await as(app, alice).post("/api/v1/events").send({
        title: "Team lunch",
        location: "Cafe",
        startsAtLocal: "2030-05-02T12:00",
        endsAtLocal: "2030-05-02T13:30",
        timezone: "Europe/London",
        sourceMessageId: messageId,
      });
      expect(created.status).toBe(201);
      const event = created.body.event;
      expect(event).toMatchObject({ startsAt: "2030-05-02T11:00:00.000Z", endsAt: "2030-05-02T12:30:00.000Z", location: "Cafe" });

      expect((await as(app, alice).get("/api/v1/events?from=2030-05-01T00:00:00Z&to=2030-05-03T00:00:00Z")).body.events).toHaveLength(1);
      expect((await as(app, alice).get("/api/v1/events?from=2030-06-01T00:00:00Z")).body.events).toHaveLength(0);

      const updated = await as(app, alice).patch(`/api/v1/events/${event.id}`).send({ title: "Team lunch (moved)" });
      expect(updated.body.event.title).toBe("Team lunch (moved)");
      expect((await as(app, bob).get(`/api/v1/events/${event.id}`)).status).toBe(404);
      expect((await as(app, alice).delete(`/api/v1/events/${event.id}`)).status).toBe(204);
    });

    it("rejects an end before the start", async () => {
      const res = await as(app, alice).post("/api/v1/events").send({ title: "x", startsAt: "2030-05-02T12:00:00Z", endsAt: "2030-05-02T11:00:00Z" });
      expect(res.status).toBe(400);
    });
  });

  it("group tasks can be assigned to group members only", async () => {
    const { conversationId } = await createGroup(app, alice, [bob]);
    const ok = await as(app, alice).post("/api/v1/tasks").send({ title: "x", sourceConversationId: conversationId, assigneeId: bob.userId });
    expect(ok.status).toBe(201);
    const no = await as(app, alice).post("/api/v1/tasks").send({ title: "x", sourceConversationId: conversationId, assigneeId: carol.userId });
    expect(no.status).toBe(400);
  });
});
