import type { Express } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import type { Container } from "../../src/container";
import { FakeRealtimeGateway } from "../helpers/fakeRealtimeGateway";
import { createDirectConversation, createGroup, SAMPLE_FILES, sendMessage, uploadFile, uploadStatusMedia } from "../helpers/fixtures";
import { MemoryStorageProvider } from "../helpers/memoryStorage";
import { createTestDb } from "../helpers/testDb";
import { signupTestUser, type TestUser } from "../helpers/testUser";

function auth(user: TestUser) {
  return { Authorization: `Bearer ${user.accessToken}` };
}

describe("Status API", () => {
  let app: Express;
  let container: Container;
  let gateway: FakeRealtimeGateway;
  let storage: MemoryStorageProvider;
  /** Owner of most statuses below. */
  let alice: TestUser;
  /** Alice's contact: Alice has messaged Bob directly. */
  let bob: TestUser;
  /** Shares only a group with Alice. */
  let carol: TestUser;
  /** Opened a direct chat with Alice, but Alice never replied — NOT her contact. */
  let dave: TestUser;
  /** A stranger. */
  let eve: TestUser;

  beforeAll(async () => {
    const db = await createTestDb();
    gateway = new FakeRealtimeGateway();
    storage = new MemoryStorageProvider();
    ({ app, container } = createApp({ db, realtimeGateway: gateway, storage }));
    alice = await signupTestUser(app, { displayName: "Alice" });
    bob = await signupTestUser(app, { displayName: "Bob" });
    carol = await signupTestUser(app, { displayName: "Carol" });
    dave = await signupTestUser(app, { displayName: "Dave" });
    eve = await signupTestUser(app, { displayName: "Eve" });

    const aliceBob = await createDirectConversation(app, bob, alice);
    await sendMessage(app, alice, aliceBob, { body: "hi Bob" });
    const daveAlice = await createDirectConversation(app, dave, alice);
    await sendMessage(app, dave, daveAlice, { body: "hey, remember me?" });
    await createGroup(app, carol, [alice]);
  });

  beforeEach(() => {
    gateway.sentEvents.length = 0;
  });

  function createStatus(user: TestUser, body: Record<string, unknown>) {
    return request(app).post("/api/v1/statuses").set(auth(user)).send(body);
  }

  async function visibleStatusIds(viewer: TestUser): Promise<string[]> {
    const res = await request(app).get("/api/v1/statuses").set(auth(viewer));
    expect(res.status).toBe(200);
    return (res.body.feed as Array<{ statuses: Array<{ id: string }> }>).flatMap((entry) => entry.statuses.map((s) => s.id));
  }

  async function expire(statusId: string) {
    await container.db.query(
      "UPDATE statuses SET created_at = now() - interval '25 hours', expires_at = now() - interval '1 hour' WHERE id = $1",
      [statusId]
    );
  }

  describe("creation", () => {
    it("creates a text status that expires 24h later, decided by the server", async () => {
      const res = await createStatus(alice, {
        type: "text",
        text: "Hello world",
        backgroundColor: "rose",
        expiresAt: "2099-01-01T00:00:00Z", // ignored — clients can't choose expiry
        privacy: { visibility: "contacts" },
      });
      expect(res.status).toBe(201);
      const status = res.body.status;
      expect(status).toMatchObject({ type: "text", text: "Hello world", backgroundColor: "rose", visibility: "contacts", viewCount: 0 });
      const lifetime = new Date(status.expiresAt).getTime() - new Date(status.createdAt).getTime();
      expect(Math.abs(lifetime - 24 * 60 * 60 * 1000)).toBeLessThan(5000);

      const mine = await request(app).get("/api/v1/statuses").set(auth(alice));
      expect(mine.body.mine.map((s: { id: string }) => s.id)).toContain(status.id);
    });

    it.each([
      ["a text status without text", { type: "text" }],
      ["a text status with media", { type: "text", text: "x", attachmentId: "11111111-1111-4111-8111-111111111111" }],
      ["an image status without an upload", { type: "image", text: "caption" }],
      ["a background on an image", { type: "image", attachmentId: "11111111-1111-4111-8111-111111111111", backgroundColor: "rose" }],
      ["an unknown type", { type: "poll", text: "?" }],
      ["overlong text", { type: "text", text: "x".repeat(701) }],
      ["an unknown visibility", { type: "text", text: "x", privacy: { visibility: "friends-of-friends" } }],
      ["selected with nobody", { type: "text", text: "x", privacy: { visibility: "selected", userIds: [] } }],
    ])("rejects %s", async (_label, body) => {
      expect((await createStatus(alice, body)).status).toBe(400);
    });

    it("requires authentication", async () => {
      expect((await request(app).post("/api/v1/statuses").send({ type: "text", text: "x" })).status).toBe(401);
      expect((await request(app).get("/api/v1/statuses")).status).toBe(401);
    });
  });

  describe("privacy", () => {
    it("contacts: only people Alice actually chats with directly", async () => {
      const { body } = await createStatus(alice, { type: "text", text: "contacts only", privacy: { visibility: "contacts" } });
      expect(await visibleStatusIds(bob)).toContain(body.status.id);
      for (const user of [carol, dave, eve]) {
        expect(await visibleStatusIds(user)).not.toContain(body.status.id);
        expect((await request(app).get(`/api/v1/statuses/${body.status.id}`).set(auth(user))).status).toBe(404);
      }
      // Realtime notification goes to the owner and allowed viewers only.
      expect(gateway.eventsFor(bob.userId)).toContainEqual({ type: "status:created", statusId: body.status.id, userId: alice.userId });
      expect(gateway.eventsFor(alice.userId)).toContainEqual(expect.objectContaining({ type: "status:created" }));
      for (const user of [carol, dave, eve]) expect(gateway.eventsFor(user.userId)).toEqual([]);
    });

    it("everyone: contacts plus group co-members — still not strangers", async () => {
      const { body } = await createStatus(alice, { type: "text", text: "for everyone", privacy: { visibility: "everyone" } });
      expect(await visibleStatusIds(bob)).toContain(body.status.id);
      expect(await visibleStatusIds(carol)).toContain(body.status.id);
      expect(await visibleStatusIds(eve)).not.toContain(body.status.id);
      expect((await request(app).get(`/api/v1/statuses/${body.status.id}`).set(auth(eve))).status).toBe(404);
    });

    it("selected: exactly the chosen users, even non-contacts", async () => {
      const { body } = await createStatus(alice, {
        type: "text",
        text: "just you two",
        privacy: { visibility: "selected", userIds: [carol.userId, eve.userId] },
      });
      expect(body.status.audienceUserIds.sort()).toEqual([carol.userId, eve.userId].sort());
      expect(await visibleStatusIds(carol)).toContain(body.status.id);
      expect(await visibleStatusIds(eve)).toContain(body.status.id);
      expect(await visibleStatusIds(bob)).not.toContain(body.status.id);
    });

    it("except: contacts minus the hidden users", async () => {
      const { body } = await createStatus(alice, {
        type: "text",
        text: "not for Bob",
        privacy: { visibility: "except", userIds: [bob.userId] },
      });
      expect(await visibleStatusIds(bob)).not.toContain(body.status.id);
      expect((await request(app).get(`/api/v1/statuses/${body.status.id}`).set(auth(bob))).status).toBe(404);
      expect((await request(app).post(`/api/v1/statuses/${body.status.id}/view`).set(auth(bob))).status).toBe(404);
    });

    it("only exposes privacy details (visibility, audience, view count) to the owner", async () => {
      const { body } = await createStatus(alice, { type: "text", text: "details", privacy: { visibility: "contacts" } });
      const asBob = await request(app).get(`/api/v1/statuses/${body.status.id}`).set(auth(bob));
      expect(asBob.status).toBe(200);
      expect(asBob.body.status).not.toHaveProperty("visibility");
      expect(asBob.body.status).not.toHaveProperty("audienceUserIds");
      expect(asBob.body.status).not.toHaveProperty("viewCount");
    });

    it("saves default privacy and applies it to new statuses", async () => {
      const initial = await request(app).get("/api/v1/statuses/privacy").set(auth(bob));
      expect(initial.body.privacy).toEqual({ visibility: "contacts", userIds: [] });

      const saved = await request(app)
        .put("/api/v1/statuses/privacy")
        .set(auth(bob))
        .send({ visibility: "selected", userIds: [eve.userId, eve.userId, bob.userId] });
      expect(saved.status).toBe(200);
      expect(saved.body.privacy).toEqual({ visibility: "selected", userIds: [eve.userId] });

      const { body } = await createStatus(bob, { type: "text", text: "uses my default" });
      expect(body.status).toMatchObject({ visibility: "selected", audienceUserIds: [eve.userId] });
      expect(await visibleStatusIds(eve)).toContain(body.status.id);
      expect(await visibleStatusIds(alice)).not.toContain(body.status.id);

      const bad = await request(app)
        .put("/api/v1/statuses/privacy")
        .set(auth(bob))
        .send({ visibility: "except", userIds: ["11111111-1111-4111-8111-111111111111"] });
      expect(bad.status).toBe(400);
      await request(app).put("/api/v1/statuses/privacy").set(auth(bob)).send({ visibility: "contacts" });
    });
  });

  describe("viewing and viewers", () => {
    it("records one view per user, notifies the owner, and shows viewers only to the owner", async () => {
      const { body } = await createStatus(alice, { type: "text", text: "who's watching", privacy: { visibility: "everyone" } });
      const statusId = body.status.id as string;

      const first = await request(app).post(`/api/v1/statuses/${statusId}/view`).set(auth(bob));
      expect(first.status).toBe(200);
      expect(first.body.viewedAt).toBeTruthy();
      await request(app).post(`/api/v1/statuses/${statusId}/view`).set(auth(bob));
      await request(app).post(`/api/v1/statuses/${statusId}/view`).set(auth(carol));
      // The owner looking at their own status isn't a view.
      await request(app).post(`/api/v1/statuses/${statusId}/view`).set(auth(alice));

      const viewers = await request(app).get(`/api/v1/statuses/${statusId}/viewers`).set(auth(alice));
      expect(viewers.status).toBe(200);
      expect(viewers.body.viewers.map((v: { displayName: string }) => v.displayName).sort()).toEqual(["Bob", "Carol"]);

      const viewedEvents = gateway.eventsFor(alice.userId).filter((e) => e.type === "status:viewed");
      expect(viewedEvents).toHaveLength(2); // Bob's repeat view isn't re-announced
      expect(viewedEvents[1]).toMatchObject({ statusId, viewCount: 2, viewer: { displayName: "Carol" } });

      expect((await request(app).get(`/api/v1/statuses/${statusId}/viewers`).set(auth(bob))).status).toBe(403);
      expect((await request(app).get(`/api/v1/statuses/${statusId}/viewers`).set(auth(eve))).status).toBe(404);

      const bobFeed = await request(app).get("/api/v1/statuses").set(auth(bob));
      const entry = bobFeed.body.feed.find((e: { user: { id: string } }) => e.user.id === alice.userId);
      expect(entry.statuses.find((s: { id: string }) => s.id === statusId).viewedByMe).toBe(true);

      const mine = await request(app).get("/api/v1/statuses").set(auth(alice));
      expect(mine.body.mine.find((s: { id: string }) => s.id === statusId).viewCount).toBe(2);
    });
  });

  describe("expiry", () => {
    it("drops expired statuses from every query, then the sweep deletes them and notifies the audience", async () => {
      const upload = await uploadStatusMedia(app, alice, "sunset.png", SAMPLE_FILES.png, "image/png");
      const { body } = await createStatus(alice, {
        type: "image",
        attachmentId: upload.body.attachment.id,
        text: "sunset",
        privacy: { visibility: "contacts" },
      });
      const statusId = body.status.id as string;
      expect(await visibleStatusIds(bob)).toContain(statusId);

      await expire(statusId);

      expect(await visibleStatusIds(bob)).not.toContain(statusId);
      const mine = await request(app).get("/api/v1/statuses").set(auth(alice));
      expect(mine.body.mine.map((s: { id: string }) => s.id)).not.toContain(statusId);
      expect((await request(app).get(`/api/v1/statuses/${statusId}`).set(auth(bob))).status).toBe(404);
      expect((await request(app).post(`/api/v1/statuses/${statusId}/view`).set(auth(bob))).status).toBe(404);
      expect((await request(app).get(`/api/v1/media/${upload.body.attachment.id}/content`).set(auth(bob))).status).toBe(404);

      gateway.sentEvents.length = 0;
      expect(await container.statusesService.sweepExpired()).toBeGreaterThanOrEqual(1);
      expect(gateway.eventsFor(bob.userId)).toContainEqual({ type: "status:expired", statusIds: [statusId], userId: alice.userId });
      expect(gateway.eventsFor(eve.userId)).toEqual([]);
      expect([...storage.files.keys()].some((key) => key.endsWith(upload.body.attachment.id))).toBe(false);
      expect((await container.db.query("SELECT 1 FROM statuses WHERE id = $1", [statusId])).rowCount).toBe(0);
    });
  });

  describe("deletion", () => {
    it("lets only the owner delete, and tells the audience", async () => {
      const upload = await uploadStatusMedia(app, alice, "clip.mp4", SAMPLE_FILES.mp4, "video/mp4");
      const { body } = await createStatus(alice, { type: "video", attachmentId: upload.body.attachment.id, privacy: { visibility: "contacts" } });
      const statusId = body.status.id as string;

      expect((await request(app).delete(`/api/v1/statuses/${statusId}`).set(auth(bob))).status).toBe(403);
      expect((await request(app).delete(`/api/v1/statuses/${statusId}`).set(auth(eve))).status).toBe(404);

      gateway.sentEvents.length = 0;
      expect((await request(app).delete(`/api/v1/statuses/${statusId}`).set(auth(alice))).status).toBe(204);
      expect(gateway.eventsFor(bob.userId)).toContainEqual({ type: "status:deleted", statusId, userId: alice.userId });
      expect([...storage.files.keys()].some((key) => key.endsWith(upload.body.attachment.id))).toBe(false);
      expect((await request(app).get(`/api/v1/statuses/${statusId}`).set(auth(alice))).status).toBe(404);
    });
  });

  describe("status media", () => {
    it("stores status uploads outside any conversation, readable only per the status' privacy", async () => {
      const upload = await uploadStatusMedia(app, alice, "../../me.png", SAMPLE_FILES.png, "image/png");
      expect(upload.status).toBe(201);
      expect(upload.body.attachment).toMatchObject({ purpose: "status", conversationId: null, originalFilename: "me.png" });
      expect(upload.body.attachment).not.toHaveProperty("storageKey");
      const attachmentId = upload.body.attachment.id as string;

      // Unpublished: only the uploader can read it.
      expect((await request(app).get(`/api/v1/media/${attachmentId}/content`).set(auth(alice))).status).toBe(200);
      expect((await request(app).get(`/api/v1/media/${attachmentId}/content`).set(auth(bob))).status).toBe(404);

      await createStatus(alice, { type: "image", attachmentId, privacy: { visibility: "contacts" } });
      expect((await request(app).get(`/api/v1/media/${attachmentId}/content`).set(auth(bob))).status).toBe(200);
      expect((await request(app).get(`/api/v1/media/${attachmentId}`).set(auth(eve))).status).toBe(404);
      expect((await request(app).get(`/api/v1/media/${attachmentId}/content`).set(auth(carol))).status).toBe(404);

      // Published media can't be deleted out from under the status.
      expect((await request(app).delete(`/api/v1/media/${attachmentId}`).set(auth(alice))).status).toBe(409);
    });

    it("validates status media: type, contents, ownership, kind, and single use", async () => {
      expect((await uploadStatusMedia(app, alice, "notes.pdf", SAMPLE_FILES.pdf)).status).toBe(415);
      expect((await uploadStatusMedia(app, alice, "virus.png", SAMPLE_FILES.exe)).status).toBe(415);

      const withConversation = await request(app)
        .post(`/api/v1/media?purpose=status&filename=x.png&conversationId=11111111-1111-4111-8111-111111111111`)
        .set(auth(alice))
        .set("Content-Type", "application/octet-stream")
        .send(SAMPLE_FILES.png);
      expect(withConversation.status).toBe(400);

      const image = await uploadStatusMedia(app, alice, "pic.jpg", SAMPLE_FILES.jpg);
      const imageId = image.body.attachment.id as string;
      // Kind must match the declared status type.
      expect((await createStatus(alice, { type: "video", attachmentId: imageId })).status).toBe(400);
      // Someone else's upload looks like it doesn't exist.
      expect((await createStatus(bob, { type: "image", attachmentId: imageId })).status).toBe(404);

      // A chat attachment can't become a status.
      const aliceBob = await createDirectConversation(app, alice, bob);
      const chatUpload = await uploadFile(app, alice, aliceBob, "chat.png", SAMPLE_FILES.png);
      expect((await createStatus(alice, { type: "image", attachmentId: chatUpload.body.attachment.id })).status).toBe(400);

      // One upload, one status.
      expect((await createStatus(alice, { type: "image", attachmentId: imageId })).status).toBe(201);
      expect((await createStatus(alice, { type: "image", attachmentId: imageId })).status).toBe(409);

      // And status media can't be smuggled into a chat message.
      const smuggled = await sendMessage(app, alice, aliceBob, { attachmentId: imageId });
      expect(smuggled.status).toBeGreaterThanOrEqual(400);
    });
  });
});
