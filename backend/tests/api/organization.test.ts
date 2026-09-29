import type { Express } from "express";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { as } from "../helpers/api";
import { FakeRealtimeGateway } from "../helpers/fakeRealtimeGateway";
import { createDirectConversation, createGroup, sendMessage } from "../helpers/fixtures";
import { createTestDb } from "../helpers/testDb";
import { signupTestUser, type TestUser } from "../helpers/testUser";

describe("Pins, saved messages, preferences and focus (Phase 6)", () => {
  let app: Express;
  let gateway: FakeRealtimeGateway;
  let alice: TestUser;
  let bob: TestUser;
  let carol: TestUser;
  let directId: string;
  let messageId: string;

  beforeEach(async () => {
    gateway = new FakeRealtimeGateway();
    ({ app } = createApp({ db: await createTestDb(), realtimeGateway: gateway }));
    alice = await signupTestUser(app, { displayName: "Alice" });
    bob = await signupTestUser(app, { displayName: "Bob" });
    carol = await signupTestUser(app, { displayName: "Carol" });
    directId = await createDirectConversation(app, alice, bob);
    messageId = (await sendMessage(app, bob, directId, { body: "The wifi password is hunter2" })).body.message.id;
  });

  describe("pinned messages", () => {
    it("pins, lists (linking back to the message) and unpins in a direct chat", async () => {
      const pinned = await as(app, alice).post("/api/v1/pins").send({ messageId });
      expect(pinned.status).toBe(201);
      expect(pinned.body.pin).toMatchObject({ conversationId: directId, messageId, pinnedBy: { id: alice.userId } });
      expect(pinned.body.pin.message).toMatchObject({ id: messageId, body: "The wifi password is hunter2", senderDisplayName: "Bob" });
      expect(gateway.eventsFor(bob.userId).some((e) => e.type === "message:pinned")).toBe(true);

      const list = await as(app, bob).get(`/api/v1/pins?conversationId=${directId}`);
      expect(list.body.pins).toHaveLength(1);

      expect((await as(app, bob).delete(`/api/v1/pins/${messageId}`)).status).toBe(204);
      expect((await as(app, alice).get(`/api/v1/pins?conversationId=${directId}`)).body.pins).toHaveLength(0);
      expect(gateway.eventsFor(alice.userId).some((e) => e.type === "message:unpinned")).toBe(true);
    });

    it("is off-limits to non-members", async () => {
      await as(app, alice).post("/api/v1/pins").send({ messageId });
      expect((await as(app, carol).get(`/api/v1/pins?conversationId=${directId}`)).status).toBe(403);
      expect((await as(app, carol).post("/api/v1/pins").send({ messageId })).status).toBe(404);
      expect((await as(app, carol).delete(`/api/v1/pins/${messageId}`)).status).toBe(404);
    });

    it("in groups, only the owner/admins may pin", async () => {
      const { conversationId, groupId } = await createGroup(app, alice, [bob, carol]);
      const groupMessage = (await sendMessage(app, carol, conversationId, { body: "Agenda" })).body.message.id;
      expect((await as(app, carol).post("/api/v1/pins").send({ messageId: groupMessage })).status).toBe(403);
      expect((await as(app, alice).post("/api/v1/pins").send({ messageId: groupMessage })).status).toBe(201);
      expect((await as(app, carol).delete(`/api/v1/pins/${groupMessage}`)).status).toBe(403);

      await as(app, alice).patch(`/api/v1/groups/${groupId}/members/${bob.userId}/role`).send({ role: "admin" });
      expect((await as(app, bob).delete(`/api/v1/pins/${groupMessage}`)).status).toBe(204);
    });

    it("drops the pin when the message is deleted", async () => {
      await as(app, alice).post("/api/v1/pins").send({ messageId });
      await as(app, bob).delete(`/api/v1/messages/${directId}/${messageId}`);
      expect((await as(app, alice).get(`/api/v1/pins?conversationId=${directId}`)).body.pins).toHaveLength(0);
    });
  });

  describe("saved messages", () => {
    it("saves, labels, stars, searches and unsaves messages privately", async () => {
      const other = (await sendMessage(app, alice, directId, { body: "Dinner at 8?" })).body.message.id;
      const saved = await as(app, alice).put(`/api/v1/saved/${messageId}`).send({ label: "Home", starred: true, note: "router" });
      expect(saved.status).toBe(200);
      expect(saved.body.saved).toMatchObject({ messageId, label: "Home", starred: true, conversationTitle: "Bob" });
      await as(app, alice).put(`/api/v1/saved/${other}`).send({});

      expect((await as(app, alice).get("/api/v1/saved")).body.saved).toHaveLength(2);
      expect((await as(app, alice).get("/api/v1/saved?starred=true")).body.saved).toHaveLength(1);
      expect((await as(app, alice).get("/api/v1/saved?label=Home")).body.saved[0].messageId).toBe(messageId);
      expect((await as(app, alice).get("/api/v1/saved?q=wifi")).body.saved[0].messageId).toBe(messageId);
      expect((await as(app, alice).get("/api/v1/saved?q=router")).body.saved[0].messageId).toBe(messageId);
      expect((await as(app, alice).get("/api/v1/saved?q=nothing-matches")).body.saved).toHaveLength(0);
      expect((await as(app, alice).get("/api/v1/saved/labels")).body.labels).toEqual(["Home"]);

      const restarred = await as(app, alice).put(`/api/v1/saved/${messageId}`).send({ starred: false });
      expect(restarred.body.saved).toMatchObject({ starred: false, label: "Home" });

      // Private: Bob sees none of Alice's saves.
      expect((await as(app, bob).get("/api/v1/saved")).body.saved).toHaveLength(0);
      expect(gateway.eventsFor(bob.userId).some((e) => e.type === "saved:updated")).toBe(false);

      expect((await as(app, alice).delete(`/api/v1/saved/${messageId}`)).status).toBe(204);
      expect((await as(app, alice).delete(`/api/v1/saved/${messageId}`)).status).toBe(404);
    });

    it("can't save a message you can't read, and hides saves after you lose access", async () => {
      expect((await as(app, carol).put(`/api/v1/saved/${messageId}`).send({})).status).toBe(404);

      const { conversationId, groupId } = await createGroup(app, alice, [carol]);
      const groupMessage = (await sendMessage(app, alice, conversationId, { body: "group secret" })).body.message.id;
      await as(app, carol).put(`/api/v1/saved/${groupMessage}`).send({});
      expect((await as(app, carol).get("/api/v1/saved")).body.saved).toHaveLength(1);
      await as(app, alice).delete(`/api/v1/groups/${groupId}/members/${carol.userId}`);
      expect((await as(app, carol).get("/api/v1/saved")).body.saved).toHaveLength(0);
    });
  });

  describe("preferences and focused conversations", () => {
    it("stores preferences and syncs them to the user's devices", async () => {
      const defaults = await as(app, alice).get("/api/v1/preferences");
      expect(defaults.body.preferences).toMatchObject({ productivityMode: false, notifyMentions: true, timezone: null });

      const updated = await as(app, alice).patch("/api/v1/preferences").send({ productivityMode: true, timezone: "Europe/Paris" });
      expect(updated.body.preferences).toMatchObject({ productivityMode: true, timezone: "Europe/Paris" });
      expect(gateway.eventsFor(alice.userId).some((e) => e.type === "preferences:updated")).toBe(true);
      expect((await as(app, bob).get("/api/v1/preferences")).body.preferences.productivityMode).toBe(false);
      expect((await as(app, alice).patch("/api/v1/preferences").send({})).status).toBe(400);
    });

    it("focuses only conversations the user belongs to", async () => {
      const res = await as(app, alice).put(`/api/v1/preferences/focus/${directId}`);
      expect(res.body.conversationIds).toEqual([directId]);
      expect((await as(app, carol).put(`/api/v1/preferences/focus/${directId}`)).status).toBe(403);
      expect((await as(app, alice).delete(`/api/v1/preferences/focus/${directId}`)).body.conversationIds).toEqual([]);
    });
  });
});
