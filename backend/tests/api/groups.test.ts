import type { Express } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import type { Container } from "../../src/container";
import { FakeRealtimeGateway } from "../helpers/fakeRealtimeGateway";
import { createGroup } from "../helpers/fixtures";
import { createTestDb } from "../helpers/testDb";
import { signupTestUser, type TestUser } from "../helpers/testUser";

function auth(user: TestUser) {
  return { Authorization: `Bearer ${user.accessToken}` };
}

describe("Groups API", () => {
  let app: Express;
  let container: Container;
  let gateway: FakeRealtimeGateway;
  let owner: TestUser;
  let alice: TestUser;
  let bob: TestUser;
  let carol: TestUser;
  let eve: TestUser;

  // Users are created once (bcrypt is slow); each test builds its own group, so tests stay independent.
  beforeAll(async () => {
    const db = await createTestDb();
    ({ app, container } = createApp({ db }));
    owner = await signupTestUser(app, { displayName: "Olivia Owner" });
    alice = await signupTestUser(app, { displayName: "Alice" });
    bob = await signupTestUser(app, { displayName: "Bob" });
    carol = await signupTestUser(app, { displayName: "Carol" });
    eve = await signupTestUser(app, { displayName: "Eve Outsider" });
  });

  beforeEach(() => {
    gateway = new FakeRealtimeGateway();
    container.realtimeGatewayRef.current = gateway;
  });

  async function promote(groupId: string, user: TestUser) {
    const res = await request(app)
      .patch(`/api/v1/groups/${groupId}/members/${user.userId}/role`)
      .set(auth(owner))
      .send({ role: "admin" });
    expect(res.status).toBe(200);
  }

  describe("creation", () => {
    it("creates a group with the creator as owner and the selected members", async () => {
      const res = await request(app)
        .post("/api/v1/groups")
        .set(auth(owner))
        .send({ name: "  Weekend Trip  ", description: "Planning", memberIds: [alice.userId, bob.userId] });

      expect(res.status).toBe(201);
      expect(res.body.group).toMatchObject({ name: "Weekend Trip", description: "Planning", memberCount: 3, myRole: "owner" });
      const roles = Object.fromEntries(res.body.members.map((m: { userId: string; role: string }) => [m.userId, m.role]));
      expect(roles).toEqual({ [owner.userId]: "owner", [alice.userId]: "member", [bob.userId]: "member" });

      // Every member is told to pick up the new conversation.
      for (const user of [owner, alice, bob]) {
        expect(gateway.eventsFor(user.userId)).toContainEqual({
          type: "conversation:added",
          conversationId: res.body.group.conversationId,
        });
      }
    });

    it("shows the group in each member's conversation list, but not in outsiders'", async () => {
      const { conversationId } = await createGroup(app, owner, [alice], "Listed Group");

      const aliceList = await request(app).get("/api/v1/conversations").set(auth(alice));
      const entry = aliceList.body.conversations.find((c: { id: string }) => c.id === conversationId);
      expect(entry).toMatchObject({
        type: "group",
        otherParticipant: null,
        group: { name: "Listed Group", memberCount: 2, myRole: "member" },
        unreadCount: 0,
      });

      const eveList = await request(app).get("/api/v1/conversations").set(auth(eve));
      expect(eveList.body.conversations.some((c: { id: string }) => c.id === conversationId)).toBe(false);
    });

    it("de-duplicates repeated member IDs and ignores the creator in the member list", async () => {
      const res = await request(app)
        .post("/api/v1/groups")
        .set(auth(owner))
        .send({ name: "Dupes", memberIds: [alice.userId, alice.userId, owner.userId] });
      expect(res.status).toBe(201);
      expect(res.body.group.memberCount).toBe(2);
    });

    it("validates input", async () => {
      const noName = await request(app).post("/api/v1/groups").set(auth(owner)).send({ name: " ", memberIds: [alice.userId] });
      expect(noName.status).toBe(400);

      const noMembers = await request(app).post("/api/v1/groups").set(auth(owner)).send({ name: "Solo", memberIds: [] });
      expect(noMembers.status).toBe(400);

      const onlySelf = await request(app).post("/api/v1/groups").set(auth(owner)).send({ name: "Solo", memberIds: [owner.userId] });
      expect(onlySelf.status).toBe(400);

      const unknownUser = await request(app)
        .post("/api/v1/groups")
        .set(auth(owner))
        .send({ name: "Ghosts", memberIds: ["00000000-0000-4000-8000-000000000000"] });
      expect(unknownUser.status).toBe(400);
      expect(unknownUser.body.error.message).toMatch(/Unknown or inactive users/);

      const badAvatar = await request(app)
        .post("/api/v1/groups")
        .set(auth(owner))
        .send({ name: "Avatar", memberIds: [alice.userId], avatarUrl: "javascript:alert(1)" });
      expect(badAvatar.status).toBe(400);
    });

    it("requires authentication", async () => {
      const res = await request(app).post("/api/v1/groups").send({ name: "x", memberIds: [alice.userId] });
      expect(res.status).toBe(401);
    });
  });

  describe("reading", () => {
    it("lets members read group details and members, and blocks non-members", async () => {
      const { groupId } = await createGroup(app, owner, [alice]);

      const asMember = await request(app).get(`/api/v1/groups/${groupId}`).set(auth(alice));
      expect(asMember.status).toBe(200);
      expect(asMember.body.group.myRole).toBe("member");

      const members = await request(app).get(`/api/v1/groups/${groupId}/members`).set(auth(alice));
      expect(members.status).toBe(200);
      expect(members.body.members[0]).toMatchObject({ userId: owner.userId, role: "owner", displayName: "Olivia Owner" });

      expect((await request(app).get(`/api/v1/groups/${groupId}`).set(auth(eve))).status).toBe(403);
      expect((await request(app).get(`/api/v1/groups/${groupId}/members`).set(auth(eve))).status).toBe(403);
    });

    it("returns 404 for an unknown group and 400 for a malformed ID", async () => {
      expect((await request(app).get("/api/v1/groups/00000000-0000-4000-8000-000000000000").set(auth(owner))).status).toBe(404);
      expect((await request(app).get("/api/v1/groups/not-a-uuid").set(auth(owner))).status).toBe(400);
    });
  });

  describe("editing group details", () => {
    it("allows owners and admins, rejects plain members and outsiders, and broadcasts the change", async () => {
      const { groupId, conversationId } = await createGroup(app, owner, [alice, bob]);
      await promote(groupId, alice);

      const byAdmin = await request(app).patch(`/api/v1/groups/${groupId}`).set(auth(alice)).send({ name: "Renamed" });
      expect(byAdmin.status).toBe(200);
      expect(byAdmin.body.group.name).toBe("Renamed");
      expect(gateway.eventsFor(bob.userId)).toContainEqual(
        expect.objectContaining({ type: "group:updated", conversationId, group: expect.objectContaining({ name: "Renamed" }) })
      );

      const byMember = await request(app).patch(`/api/v1/groups/${groupId}`).set(auth(bob)).send({ name: "Hijacked" });
      expect(byMember.status).toBe(403);

      const byOutsider = await request(app).patch(`/api/v1/groups/${groupId}`).set(auth(eve)).send({ name: "Hijacked" });
      expect(byOutsider.status).toBe(403);

      const clearDescription = await request(app)
        .patch(`/api/v1/groups/${groupId}`)
        .set(auth(owner))
        .send({ description: null, avatarUrl: "https://example.com/g.png" });
      expect(clearDescription.body.group).toMatchObject({ description: null, avatarUrl: "https://example.com/g.png" });
    });
  });

  describe("adding members", () => {
    it("lets an admin add members and notifies existing and new members", async () => {
      const { groupId, conversationId } = await createGroup(app, owner, [alice]);
      await promote(groupId, alice);

      const res = await request(app).post(`/api/v1/groups/${groupId}/members`).set(auth(alice)).send({ userIds: [bob.userId] });
      expect(res.status).toBe(200);
      expect(res.body.group.memberCount).toBe(3);

      expect(gateway.eventsFor(owner.userId)).toContainEqual(
        expect.objectContaining({ type: "group:member_added", userIds: [bob.userId], addedBy: alice.userId })
      );
      expect(gateway.eventsFor(bob.userId)).toContainEqual({ type: "conversation:added", conversationId });
    });

    it("prevents duplicate memberships", async () => {
      const { groupId } = await createGroup(app, owner, [alice]);
      const res = await request(app).post(`/api/v1/groups/${groupId}/members`).set(auth(owner)).send({ userIds: [alice.userId] });
      expect(res.status).toBe(409);

      const members = await request(app).get(`/api/v1/groups/${groupId}/members`).set(auth(owner));
      expect(members.body.members.filter((m: { userId: string }) => m.userId === alice.userId)).toHaveLength(1);
    });

    it("forbids plain members and outsiders from adding people", async () => {
      const { groupId } = await createGroup(app, owner, [alice]);
      expect(
        (await request(app).post(`/api/v1/groups/${groupId}/members`).set(auth(alice)).send({ userIds: [bob.userId] })).status
      ).toBe(403);
      expect(
        (await request(app).post(`/api/v1/groups/${groupId}/members`).set(auth(eve)).send({ userIds: [eve.userId] })).status
      ).toBe(403);
    });
  });

  describe("removing members", () => {
    it("lets an admin remove a plain member, who loses access immediately", async () => {
      const { groupId, conversationId } = await createGroup(app, owner, [alice, bob]);
      await promote(groupId, alice);

      const res = await request(app).delete(`/api/v1/groups/${groupId}/members/${bob.userId}`).set(auth(alice));
      expect(res.status).toBe(200);
      expect(res.body.members.some((m: { userId: string }) => m.userId === bob.userId)).toBe(false);

      expect(gateway.eventsFor(bob.userId)).toContainEqual({ type: "conversation:removed", conversationId, reason: "removed" });
      expect((await request(app).get(`/api/v1/messages/${conversationId}`).set(auth(bob))).status).toBe(403);
      expect((await request(app).get(`/api/v1/groups/${groupId}`).set(auth(bob))).status).toBe(403);
    });

    it("enforces the role hierarchy", async () => {
      const { groupId } = await createGroup(app, owner, [alice, bob, carol]);
      await promote(groupId, alice);
      await promote(groupId, bob);

      // A plain member can't remove anyone.
      expect((await request(app).delete(`/api/v1/groups/${groupId}/members/${alice.userId}`).set(auth(carol))).status).toBe(403);
      // An admin can't remove another admin…
      expect((await request(app).delete(`/api/v1/groups/${groupId}/members/${bob.userId}`).set(auth(alice))).status).toBe(403);
      // …or the owner.
      expect((await request(app).delete(`/api/v1/groups/${groupId}/members/${owner.userId}`).set(auth(alice))).status).toBe(403);
      // The owner can remove an admin.
      expect((await request(app).delete(`/api/v1/groups/${groupId}/members/${bob.userId}`).set(auth(owner))).status).toBe(200);
      // Removing yourself goes through /leave instead.
      expect((await request(app).delete(`/api/v1/groups/${groupId}/members/${owner.userId}`).set(auth(owner))).status).toBe(400);
      // Removing a non-member is a 404.
      expect((await request(app).delete(`/api/v1/groups/${groupId}/members/${eve.userId}`).set(auth(owner))).status).toBe(404);
    });

    it("lets a removed member be re-added without seeing messages from before they rejoined", async () => {
      const { groupId, conversationId } = await createGroup(app, owner, [alice, bob]);
      await request(app).post(`/api/v1/messages/${conversationId}`).set(auth(owner)).send({ body: "before removal" });
      await request(app).delete(`/api/v1/groups/${groupId}/members/${bob.userId}`).set(auth(owner));
      await request(app).post(`/api/v1/messages/${conversationId}`).set(auth(owner)).send({ body: "while bob was away" });

      const readd = await request(app).post(`/api/v1/groups/${groupId}/members`).set(auth(owner)).send({ userIds: [bob.userId] });
      expect(readd.status).toBe(200);
      await request(app).post(`/api/v1/messages/${conversationId}`).set(auth(owner)).send({ body: "welcome back" });

      const history = await request(app).get(`/api/v1/messages/${conversationId}`).set(auth(bob));
      expect(history.status).toBe(200);
      expect(history.body.items.map((m: { body: string }) => m.body)).toEqual(["welcome back"]);
    });
  });

  describe("roles", () => {
    it("lets only the owner promote and demote", async () => {
      const { groupId, conversationId } = await createGroup(app, owner, [alice, bob]);

      const promoteRes = await request(app)
        .patch(`/api/v1/groups/${groupId}/members/${alice.userId}/role`)
        .set(auth(owner))
        .send({ role: "admin" });
      expect(promoteRes.status).toBe(200);
      expect(promoteRes.body.members.find((m: { userId: string }) => m.userId === alice.userId).role).toBe("admin");
      expect(gateway.eventsFor(bob.userId)).toContainEqual(
        expect.objectContaining({ type: "group:role_changed", conversationId, userId: alice.userId, role: "admin" })
      );

      // An admin cannot change roles.
      const byAdmin = await request(app)
        .patch(`/api/v1/groups/${groupId}/members/${bob.userId}/role`)
        .set(auth(alice))
        .send({ role: "admin" });
      expect(byAdmin.status).toBe(403);

      const demote = await request(app)
        .patch(`/api/v1/groups/${groupId}/members/${alice.userId}/role`)
        .set(auth(owner))
        .send({ role: "member" });
      expect(demote.body.members.find((m: { userId: string }) => m.userId === alice.userId).role).toBe("member");
    });

    it("rejects invalid role changes", async () => {
      const { groupId } = await createGroup(app, owner, [alice]);
      const toOwner = await request(app)
        .patch(`/api/v1/groups/${groupId}/members/${alice.userId}/role`)
        .set(auth(owner))
        .send({ role: "owner" });
      expect(toOwner.status).toBe(400);

      const ownerSelf = await request(app)
        .patch(`/api/v1/groups/${groupId}/members/${owner.userId}/role`)
        .set(auth(owner))
        .send({ role: "member" });
      expect(ownerSelf.status).toBe(400);

      const nonMember = await request(app)
        .patch(`/api/v1/groups/${groupId}/members/${eve.userId}/role`)
        .set(auth(owner))
        .send({ role: "admin" });
      expect(nonMember.status).toBe(404);
    });
  });

  describe("leaving", () => {
    it("lets a member leave and notifies the remaining members", async () => {
      const { groupId, conversationId } = await createGroup(app, owner, [alice, bob]);

      const res = await request(app).post(`/api/v1/groups/${groupId}/leave`).set(auth(bob));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ newOwnerId: null });

      expect(gateway.eventsFor(owner.userId)).toContainEqual(
        expect.objectContaining({ type: "group:member_left", userId: bob.userId, newOwnerId: null })
      );
      expect(gateway.eventsFor(bob.userId)).toContainEqual({ type: "conversation:removed", conversationId, reason: "left" });

      const bobList = await request(app).get("/api/v1/conversations").set(auth(bob));
      expect(bobList.body.conversations.some((c: { id: string }) => c.id === conversationId)).toBe(false);

      // Leaving twice is not possible.
      expect((await request(app).post(`/api/v1/groups/${groupId}/leave`).set(auth(bob))).status).toBe(403);
    });

    it("hands ownership to the longest-standing admin when the owner leaves", async () => {
      const { groupId } = await createGroup(app, owner, [alice, bob]);
      await promote(groupId, bob);

      const res = await request(app).post(`/api/v1/groups/${groupId}/leave`).set(auth(owner));
      expect(res.body.newOwnerId).toBe(bob.userId);

      const details = await request(app).get(`/api/v1/groups/${groupId}`).set(auth(bob));
      expect(details.body.group.myRole).toBe("owner");
      expect(details.body.members.filter((m: { role: string }) => m.role === "owner")).toHaveLength(1);
    });

    it("falls back to the longest-standing member when there are no admins", async () => {
      const { groupId } = await createGroup(app, owner, [alice, bob]);
      const res = await request(app).post(`/api/v1/groups/${groupId}/leave`).set(auth(owner));
      expect([alice.userId, bob.userId]).toContain(res.body.newOwnerId);

      const details = await request(app).get(`/api/v1/groups/${groupId}`).set(auth(alice));
      expect(details.body.members.filter((m: { role: string }) => m.role === "owner")).toHaveLength(1);
    });

    it("lets the last member leave, leaving an empty group", async () => {
      const { groupId } = await createGroup(app, owner, [alice]);
      await request(app).post(`/api/v1/groups/${groupId}/leave`).set(auth(alice));
      const res = await request(app).post(`/api/v1/groups/${groupId}/leave`).set(auth(owner));
      expect(res.status).toBe(200);
      expect(res.body.newOwnerId).toBeNull();
    });
  });

  describe("database constraints", () => {
    it("rejects a second owner and a duplicate membership at the database level", async () => {
      const { groupId } = await createGroup(app, owner, [alice]);
      await expect(
        container.db.query("UPDATE group_members SET role = 'owner' WHERE group_id = $1 AND user_id = $2", [groupId, alice.userId])
      ).rejects.toThrow();
      await expect(
        container.db.query("INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, 'member')", [groupId, alice.userId])
      ).rejects.toThrow();
    });
  });
});
