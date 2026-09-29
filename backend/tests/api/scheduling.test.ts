import type { Express } from "express";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import type { Container } from "../../src/container";
import { as, minutesFromNow } from "../helpers/api";
import { FakeRealtimeGateway } from "../helpers/fakeRealtimeGateway";
import { createDirectConversation, createGroup, sendMessage } from "../helpers/fixtures";
import { createTestDb } from "../helpers/testDb";
import { signupTestUser, type TestUser } from "../helpers/testUser";

const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000);

describe("Scheduled messages, the scheduler and notifications (Phase 6)", () => {
  let app: Express;
  let container: Container;
  let gateway: FakeRealtimeGateway;
  let alice: TestUser;
  let bob: TestUser;
  let carol: TestUser;
  let directId: string;

  beforeEach(async () => {
    gateway = new FakeRealtimeGateway();
    ({ app, container } = createApp({ db: await createTestDb(), realtimeGateway: gateway }));
    alice = await signupTestUser(app, { displayName: "Alice" });
    bob = await signupTestUser(app, { displayName: "Bob" });
    carol = await signupTestUser(app, { displayName: "Carol" });
    directId = await createDirectConversation(app, alice, bob);
  });

  describe("scheduled messages", () => {
    it("schedules, edits and delivers a message exactly once at the scheduled time", async () => {
      const created = await as(app, alice).post("/api/v1/scheduled-messages").send({ conversationId: directId, body: "Happy birthday!", scheduledFor: minutesFromNow(5) });
      expect(created.status).toBe(201);
      const scheduled = created.body.scheduledMessage;
      expect(scheduled).toMatchObject({ status: "scheduled", body: "Happy birthday!" });

      const edited = await as(app, alice).patch(`/api/v1/scheduled-messages/${scheduled.id}`).send({ body: "Happy birthday Bob!" });
      expect(edited.body.scheduledMessage.body).toBe("Happy birthday Bob!");

      // Not due yet: nothing is sent.
      await container.schedulerService.tick(new Date());
      expect((await as(app, bob).get(`/api/v1/messages/${directId}`)).body.items).toHaveLength(0);

      const result = await container.schedulerService.tick(inMinutes(6));
      expect(result?.scheduledSent).toBe(1);
      await container.schedulerService.tick(inMinutes(7));

      const messages = (await as(app, bob).get(`/api/v1/messages/${directId}`)).body.items;
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ body: "Happy birthday Bob!", senderId: alice.userId });

      const after = (await as(app, alice).get("/api/v1/scheduled-messages")).body.scheduledMessages[0];
      expect(after).toMatchObject({ status: "sent", sentMessageId: messages[0].id });
      expect(gateway.eventsFor(bob.userId).some((e) => e.type === "message:new")).toBe(true);
      expect((await as(app, alice).get("/api/v1/notifications")).body.notifications.some((n: { type: string }) => n.type === "scheduled_message_sent")).toBe(true);

      // A sent message can no longer be edited or cancelled.
      expect((await as(app, alice).patch(`/api/v1/scheduled-messages/${scheduled.id}`).send({ body: "x" })).status).toBe(409);
      expect((await as(app, alice).post(`/api/v1/scheduled-messages/${scheduled.id}/cancel`)).status).toBe(409);
    });

    it("never sends a cancelled message", async () => {
      const scheduled = (await as(app, alice).post("/api/v1/scheduled-messages").send({ conversationId: directId, body: "nope", scheduledFor: minutesFromNow(1) })).body.scheduledMessage;
      expect((await as(app, alice).post(`/api/v1/scheduled-messages/${scheduled.id}/cancel`)).body.scheduledMessage.status).toBe("cancelled");
      await container.schedulerService.tick(inMinutes(10));
      expect((await as(app, bob).get(`/api/v1/messages/${directId}`)).body.items).toHaveLength(0);
      expect((await as(app, alice).delete(`/api/v1/scheduled-messages/${scheduled.id}`)).status).toBe(204);
    });

    it("fails (instead of sending) when the sender left the conversation before delivery", async () => {
      const { conversationId, groupId } = await createGroup(app, alice, [bob, carol]);
      await as(app, carol).post("/api/v1/scheduled-messages").send({ conversationId, body: "later", scheduledFor: minutesFromNow(1) });
      await as(app, carol).post(`/api/v1/groups/${groupId}/leave`);
      await container.schedulerService.tick(inMinutes(2));

      const [scheduled] = (await as(app, carol).get("/api/v1/scheduled-messages")).body.scheduledMessages;
      expect(scheduled.status).toBe("failed");
      expect(scheduled.failureReason).toMatch(/access/);
      expect((await as(app, alice).get(`/api/v1/messages/${conversationId}`)).body.items.some((m: { body: string }) => m.body === "later")).toBe(false);
    });

    it("validates and authorizes scheduling", async () => {
      const past = await as(app, alice).post("/api/v1/scheduled-messages").send({ conversationId: directId, body: "x", scheduledFor: "2020-01-01T00:00:00Z" });
      expect(past.status).toBe(400);
      const tooFar = await as(app, alice).post("/api/v1/scheduled-messages").send({ conversationId: directId, body: "x", scheduledFor: "2099-01-01T00:00:00Z" });
      expect(tooFar.status).toBe(400);
      expect((await as(app, alice).post("/api/v1/scheduled-messages").send({ conversationId: directId, body: "", scheduledFor: minutesFromNow(5) })).status).toBe(400);
      expect((await as(app, carol).post("/api/v1/scheduled-messages").send({ conversationId: directId, body: "x", scheduledFor: minutesFromNow(5) })).status).toBe(403);

      const mine = (await as(app, alice).post("/api/v1/scheduled-messages").send({ conversationId: directId, body: "x", scheduledFor: minutesFromNow(5) })).body.scheduledMessage;
      expect((await as(app, bob).patch(`/api/v1/scheduled-messages/${mine.id}`).send({ body: "hijack" })).status).toBe(404);
      expect((await as(app, bob).post(`/api/v1/scheduled-messages/${mine.id}/cancel`)).status).toBe(404);
      expect((await as(app, bob).get("/api/v1/scheduled-messages")).body.scheduledMessages).toHaveLength(0);
    });

    it("accepts a local time in the sender's timezone", async () => {
      // 30 days ahead at 18:00 Tokyo time (UTC+9, no DST) = 09:00 UTC that day.
      const day = new Date(Date.now() + 30 * 24 * 3600_000).toISOString().slice(0, 10);
      const res = await as(app, alice).post("/api/v1/scheduled-messages").send({ conversationId: directId, body: "x", scheduledForLocal: `${day}T18:00`, timezone: "Asia/Tokyo" });
      expect(res.status).toBe(201);
      expect(res.body.scheduledMessage).toMatchObject({ scheduledFor: `${day}T09:00:00.000Z`, timezone: "Asia/Tokyo" });
    });

    it("re-queues a send interrupted by a crash without double-posting", async () => {
      const scheduled = (await as(app, alice).post("/api/v1/scheduled-messages").send({ conversationId: directId, body: "once", scheduledFor: minutesFromNow(1) })).body.scheduledMessage;
      // Simulate: message posted, then the process died before marking the row "sent".
      await container.messagesService.sendMessage({ conversationId: directId, senderId: alice.userId, body: "once", clientMessageId: scheduled.id });
      await container.db.query("UPDATE scheduled_messages SET status = 'sending' WHERE id = $1", [scheduled.id]);

      expect(await container.scheduledMessagesService.recoverStuck()).toBe(1);
      await container.schedulerService.tick(inMinutes(2));
      const messages = (await as(app, bob).get(`/api/v1/messages/${directId}`)).body.items;
      expect(messages.filter((m: { body: string }) => m.body === "once")).toHaveLength(1);
      expect((await as(app, alice).get("/api/v1/scheduled-messages")).body.scheduledMessages[0].status).toBe("sent");
    });
  });

  describe("reminders and due tasks", () => {
    it("fires a due reminder once, with an in-app notification", async () => {
      const reminder = (await as(app, alice).post("/api/v1/reminders").send({ title: "Stand up", remindAt: minutesFromNow(2) })).body.reminder;
      expect((await container.schedulerService.tick(new Date()))?.remindersFired).toBe(0);

      expect((await container.schedulerService.tick(inMinutes(3)))?.remindersFired).toBe(1);
      expect((await container.schedulerService.tick(inMinutes(4)))?.remindersFired).toBe(0);

      const fired = (await as(app, alice).get("/api/v1/reminders")).body.reminders[0];
      expect(fired).toMatchObject({ id: reminder.id, status: "fired" });
      const notifications = (await as(app, alice).get("/api/v1/notifications")).body;
      expect(notifications.notifications.filter((n: { type: string }) => n.type === "reminder")).toHaveLength(1);
      expect(notifications.notifications[0]).toMatchObject({ type: "reminder", body: "Stand up", payload: { reminderId: reminder.id } });
      expect(gateway.eventsFor(alice.userId).some((e) => e.type === "notification:new")).toBe(true);
      expect((await as(app, bob).get("/api/v1/notifications")).body.notifications.some((n: { type: string }) => n.type === "reminder")).toBe(false);
    });

    it("notifies owner and assignee when a task is due, once per due date", async () => {
      const task = (await as(app, alice).post("/api/v1/tasks").send({ title: "Ship it", dueAt: minutesFromNow(1), sourceConversationId: directId, assigneeId: bob.userId })).body.task;
      await container.schedulerService.tick(inMinutes(2));
      await container.schedulerService.tick(inMinutes(3));
      for (const user of [alice, bob]) {
        const due = (await as(app, user).get("/api/v1/notifications")).body.notifications.filter((n: { type: string }) => n.type === "task_due");
        expect(due).toHaveLength(1);
        expect(due[0].payload.taskId).toBe(task.id);
      }
      // Completed tasks don't notify.
      const done = (await as(app, alice).post("/api/v1/tasks").send({ title: "Done", dueAt: minutesFromNow(1) })).body.task;
      await as(app, alice).post(`/api/v1/tasks/${done.id}/complete`);
      expect((await container.schedulerService.tick(inMinutes(5)))?.tasksDue).toBe(0);
    });

    it("respects notification preferences", async () => {
      await as(app, alice).patch("/api/v1/preferences").send({ notifyReminders: false });
      await as(app, alice).post("/api/v1/reminders").send({ title: "quiet", remindAt: minutesFromNow(1) });
      await container.schedulerService.tick(inMinutes(2));
      expect((await as(app, alice).get("/api/v1/notifications")).body.notifications.some((n: { type: string }) => n.type === "reminder")).toBe(false);
      // The reminder itself still fired.
      expect((await as(app, alice).get("/api/v1/reminders")).body.reminders[0].status).toBe("fired");
    });
  });

  describe("notification center", () => {
    it("creates mention notifications without message content, and supports read / read-all / delete", async () => {
      const { conversationId } = await createGroup(app, alice, [bob, carol], "Launch team");
      await sendMessage(app, alice, conversationId, { body: "@Bob secret plan", mentionedUserIds: [bob.userId] });
      await sendMessage(app, carol, conversationId, { body: "@Bob again", mentionedUserIds: [bob.userId] });

      const list = await as(app, bob).get("/api/v1/notifications");
      expect(list.body.unreadCount).toBe(2);
      expect(list.body.notifications[0]).toMatchObject({ type: "mention", title: "Carol mentioned you in Launch team", body: null });
      expect(JSON.stringify(list.body)).not.toContain("secret plan");
      expect((await as(app, alice).get("/api/v1/notifications")).body.notifications.some((n: { type: string }) => n.type === "mention")).toBe(false);

      const [first, second] = list.body.notifications;
      expect((await as(app, alice).post(`/api/v1/notifications/${first.id}/read`)).status).toBe(404);
      expect((await as(app, bob).post(`/api/v1/notifications/${first.id}/read`)).status).toBe(204);
      expect((await as(app, bob).get("/api/v1/notifications/unread-count")).body.unreadCount).toBe(1);
      expect((await as(app, bob).post("/api/v1/notifications/read-all")).status).toBe(204);
      expect((await as(app, bob).get("/api/v1/notifications?unreadOnly=true")).body.notifications).toHaveLength(0);
      expect((await as(app, alice).delete(`/api/v1/notifications/${second.id}`)).status).toBe(404);
      expect((await as(app, bob).delete(`/api/v1/notifications/${second.id}`)).status).toBe(204);
    });

    it("skips mention notifications when the user switched them off", async () => {
      const { conversationId } = await createGroup(app, alice, [bob]);
      await as(app, bob).patch("/api/v1/preferences").send({ notifyMentions: false });
      await sendMessage(app, alice, conversationId, { body: "@Bob hi", mentionedUserIds: [bob.userId] });
      expect((await as(app, bob).get("/api/v1/notifications")).body.unreadCount).toBe(0);
    });
  });
});
