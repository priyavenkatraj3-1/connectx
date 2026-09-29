import type { Express } from "express";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { as } from "../helpers/api";
import { FakeRealtimeGateway } from "../helpers/fakeRealtimeGateway";
import { createDirectConversation, createGroup } from "../helpers/fixtures";
import { createTestDb } from "../helpers/testDb";
import { signupTestUser, type TestUser } from "../helpers/testUser";

describe("Shared notes and shared to-do lists (Phase 6)", () => {
  let app: Express;
  let gateway: FakeRealtimeGateway;
  let owner: TestUser;
  let member: TestUser;
  let outsider: TestUser;
  let groupId: string;
  let conversationId: string;

  beforeEach(async () => {
    gateway = new FakeRealtimeGateway();
    ({ app } = createApp({ db: await createTestDb(), realtimeGateway: gateway }));
    owner = await signupTestUser(app, { displayName: "Owner" });
    member = await signupTestUser(app, { displayName: "Member" });
    outsider = await signupTestUser(app, { displayName: "Outsider" });
    ({ groupId, conversationId } = await createGroup(app, owner, [member]));
  });

  describe("shared notes", () => {
    it("lets members create, read and edit notes, and syncs them to every member", async () => {
      const created = await as(app, member).post("/api/v1/notes").send({ conversationId, title: "Trip plan", content: "Day 1: museum" });
      expect(created.status).toBe(201);
      const note = created.body.note;
      expect(note).toMatchObject({ title: "Trip plan", version: 1, editPolicy: "members", canEdit: true, canDelete: true });
      expect(note.createdBy.displayName).toBe("Member");

      const list = await as(app, owner).get(`/api/v1/notes?conversationId=${conversationId}`);
      expect(list.body.notes).toHaveLength(1);

      const edited = await as(app, owner).patch(`/api/v1/notes/${note.id}`).send({ content: "Day 1: museum\nDay 2: beach", expectedVersion: 1 });
      expect(edited.status).toBe(200);
      expect(edited.body.note).toMatchObject({ version: 2, updatedBy: { id: owner.userId, displayName: "Owner" } });

      const memberEvents = gateway.eventsFor(member.userId).filter((e) => e.type === "note:updated");
      expect(memberEvents).toHaveLength(2);
      expect(gateway.eventsFor(outsider.userId).filter((e) => e.type.startsWith("note:"))).toHaveLength(0);
    });

    it("detects conflicting edits with expectedVersion", async () => {
      const note = (await as(app, member).post("/api/v1/notes").send({ conversationId, title: "n" })).body.note;
      await as(app, owner).patch(`/api/v1/notes/${note.id}`).send({ content: "A", expectedVersion: 1 });
      const stale = await as(app, member).patch(`/api/v1/notes/${note.id}`).send({ content: "B", expectedVersion: 1 });
      expect(stale.status).toBe(409);
      expect(stale.body.error.code).toBe("note_conflict");
    });

    it("keeps outsiders and former members out", async () => {
      const note = (await as(app, member).post("/api/v1/notes").send({ conversationId, title: "secret" })).body.note;
      expect((await as(app, outsider).get(`/api/v1/notes?conversationId=${conversationId}`)).status).toBe(403);
      expect((await as(app, outsider).get(`/api/v1/notes/${note.id}`)).status).toBe(404);
      expect((await as(app, outsider).patch(`/api/v1/notes/${note.id}`).send({ title: "x" })).status).toBe(404);
      expect((await as(app, outsider).post("/api/v1/notes").send({ conversationId, title: "x" })).status).toBe(403);

      await as(app, owner).delete(`/api/v1/groups/${groupId}/members/${member.userId}`);
      expect((await as(app, member).get(`/api/v1/notes/${note.id}`)).status).toBe(404);
      expect((await as(app, member).get(`/api/v1/notes?conversationId=${conversationId}`)).status).toBe(403);
    });

    it("enforces admin-only notes and delete permissions", async () => {
      expect((await as(app, member).post("/api/v1/notes").send({ conversationId, title: "x", editPolicy: "admins" })).status).toBe(403);
      const adminNote = (await as(app, owner).post("/api/v1/notes").send({ conversationId, title: "Rules", editPolicy: "admins" })).body.note;
      const asMember = await as(app, member).get(`/api/v1/notes/${adminNote.id}`);
      expect(asMember.body.note).toMatchObject({ canEdit: false, canDelete: false });
      expect((await as(app, member).patch(`/api/v1/notes/${adminNote.id}`).send({ content: "x" })).status).toBe(403);
      expect((await as(app, member).delete(`/api/v1/notes/${adminNote.id}`)).status).toBe(403);

      const memberNote = (await as(app, member).post("/api/v1/notes").send({ conversationId, title: "Mine" })).body.note;
      expect((await as(app, member).patch(`/api/v1/notes/${memberNote.id}`).send({ editPolicy: "admins" })).status).toBe(200);
      expect((await as(app, owner).delete(`/api/v1/notes/${memberNote.id}`)).status).toBe(204);
      expect(gateway.eventsFor(member.userId).some((e) => e.type === "note:deleted")).toBe(true);
    });

    it("works in direct conversations too", async () => {
      const directId = await createDirectConversation(app, owner, outsider);
      const note = await as(app, outsider).post("/api/v1/notes").send({ conversationId: directId, title: "Shared" });
      expect(note.status).toBe(201);
      expect((await as(app, member).get(`/api/v1/notes?conversationId=${directId}`)).status).toBe(403);
    });
  });

  describe("shared to-do lists", () => {
    it("supports the full list/item lifecycle for members", async () => {
      const list = (await as(app, owner).post("/api/v1/todo-lists").send({ conversationId, title: "Groceries" })).body.list;
      expect(list).toMatchObject({ title: "Groceries", itemCount: 0, completedCount: 0 });

      const item = await as(app, member)
        .post(`/api/v1/todo-lists/${list.id}/items`)
        .send({ title: "Milk", priority: "high", dueAt: "2030-01-01T10:00:00Z", assigneeId: owner.userId });
      expect(item.status).toBe(201);
      expect(item.body.item).toMatchObject({ title: "Milk", priority: "high", completed: false, assignee: { id: owner.userId } });
      // The assignee is notified.
      expect(gateway.eventsFor(owner.userId).some((e) => e.type === "notification:new")).toBe(true);

      const itemId = item.body.item.id;
      expect((await as(app, owner).patch(`/api/v1/todo-items/${itemId}`).send({ title: "Oat milk" })).body.item.title).toBe("Oat milk");
      const done = await as(app, owner).post(`/api/v1/todo-items/${itemId}/complete`);
      expect(done.body.item).toMatchObject({ completed: true, completedBy: owner.userId });
      expect((await as(app, member).post(`/api/v1/todo-items/${itemId}/reopen`)).body.item.completed).toBe(false);

      const full = await as(app, member).get(`/api/v1/todo-lists/${list.id}`);
      expect(full.body.list.items).toHaveLength(1);
      expect(full.body.list.itemCount).toBe(1);

      expect((await as(app, member).delete(`/api/v1/todo-items/${itemId}`)).status).toBe(204);
      expect((await as(app, member).get(`/api/v1/todo-lists?conversationId=${conversationId}`)).body.lists[0].itemCount).toBe(0);
      expect(gateway.eventsFor(member.userId).some((e) => e.type === "todo:item_updated")).toBe(true);
    });

    it("only lets authorized group members access a list", async () => {
      const list = (await as(app, owner).post("/api/v1/todo-lists").send({ conversationId, title: "L" })).body.list;
      const item = (await as(app, owner).post(`/api/v1/todo-lists/${list.id}/items`).send({ title: "I" })).body.item;

      expect((await as(app, outsider).get(`/api/v1/todo-lists?conversationId=${conversationId}`)).status).toBe(403);
      expect((await as(app, outsider).get(`/api/v1/todo-lists/${list.id}`)).status).toBe(404);
      expect((await as(app, outsider).post(`/api/v1/todo-lists/${list.id}/items`).send({ title: "x" })).status).toBe(404);
      expect((await as(app, outsider).post(`/api/v1/todo-items/${item.id}/complete`)).status).toBe(404);
      expect((await as(app, outsider).delete(`/api/v1/todo-items/${item.id}`)).status).toBe(404);
      expect((await as(app, outsider).post("/api/v1/todo-lists").send({ conversationId, title: "x" })).status).toBe(403);
      expect(gateway.eventsFor(outsider.userId).filter((e) => e.type.startsWith("todo:"))).toHaveLength(0);
    });

    it("rejects assigning to non-members and restricts deletes", async () => {
      const list = (await as(app, member).post("/api/v1/todo-lists").send({ conversationId, title: "L" })).body.list;
      expect((await as(app, member).post(`/api/v1/todo-lists/${list.id}/items`).send({ title: "x", assigneeId: outsider.userId })).status).toBe(400);

      const ownersItem = (await as(app, owner).post(`/api/v1/todo-lists/${list.id}/items`).send({ title: "owner's" })).body.item;
      const ownersList = (await as(app, owner).post("/api/v1/todo-lists").send({ conversationId, title: "Owner list" })).body.list;
      const itemOnOwnersList = (await as(app, owner).post(`/api/v1/todo-lists/${ownersList.id}/items`).send({ title: "o" })).body.item;

      // The list creator may delete items on their list; others need to be the item's creator or an admin.
      expect((await as(app, member).delete(`/api/v1/todo-items/${ownersItem.id}`)).status).toBe(204);
      expect((await as(app, member).delete(`/api/v1/todo-items/${itemOnOwnersList.id}`)).status).toBe(403);
      expect((await as(app, member).delete(`/api/v1/todo-lists/${ownersList.id}`)).status).toBe(403);
      expect((await as(app, member).patch(`/api/v1/todo-lists/${ownersList.id}`).send({ title: "x" })).status).toBe(403);
      expect((await as(app, owner).delete(`/api/v1/todo-lists/${list.id}`)).status).toBe(204);
    });
  });
});
