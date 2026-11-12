import type { Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { createTestDb } from "../helpers/testDb";
import { as } from "../helpers/api";
import { createDirectConversation, createGroup } from "../helpers/fixtures";
import { signupTestUser } from "../helpers/testUser";

describe("Users API", () => {
  let app: Express;

  beforeEach(async () => {
    const db = await createTestDb();
    app = createApp({ db }).app;
  });

  it("returns the authenticated user's own profile", async () => {
    const user = await signupTestUser(app, { displayName: "Ada Lovelace", email: "ada@example.com" });

    const res = await request(app).get("/api/v1/users/me").set("Authorization", `Bearer ${user.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: user.userId,
      email: "ada@example.com",
      displayName: "Ada Lovelace",
      bio: null,
      statusMessage: null,
    });
  });

  it("updates the authenticated user's profile", async () => {
    const user = await signupTestUser(app);

    const res = await request(app)
      .patch("/api/v1/users/me")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ bio: "Building ConnectX", statusMessage: "Available" });

    expect(res.status).toBe(200);
    expect(res.body.bio).toBe("Building ConnectX");
    expect(res.body.statusMessage).toBe("Available");
  });

  it("rejects an empty profile update", async () => {
    const user = await signupTestUser(app);
    const res = await request(app)
      .patch("/api/v1/users/me")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("finds another user by partial display name, case-insensitively", async () => {
    const searcher = await signupTestUser(app, { displayName: "Searcher" });
    await signupTestUser(app, { displayName: "Grace Hopper", email: "grace@example.com" });

    const res = await request(app)
      .get("/api/v1/users/search?q=grace")
      .set("Authorization", `Bearer ${searcher.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].displayName).toBe("Grace Hopper");
    // Search results must never leak email addresses.
    expect(res.body.results[0].email).toBeUndefined();
  });

  it("excludes the requesting user from their own search results", async () => {
    const user = await signupTestUser(app, { displayName: "Solo Searcher" });

    const res = await request(app)
      .get("/api/v1/users/search?q=solo")
      .set("Authorization", `Bearer ${user.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(0);
  });

  it("requires authentication for every users route", async () => {
    const meRes = await request(app).get("/api/v1/users/me");
    const searchRes = await request(app).get("/api/v1/users/search?q=a");
    expect(meRes.status).toBe(401);
    expect(searchRes.status).toBe(401);
  });

  describe("GET /users/:id — contact info", () => {
    it("shows the bio to someone who shares a chat, but not to a stranger", async () => {
      const alice = await signupTestUser(app, { displayName: "Alice", email: "alice@example.com" });
      const bob = await signupTestUser(app, { displayName: "Bob", email: "bob@example.com" });
      const stranger = await signupTestUser(app, { displayName: "Stranger", email: "stranger@example.com" });
      await as(app, alice).patch("/api/v1/users/me").send({ bio: "Loves compilers", statusMessage: "Busy" });
      await createDirectConversation(app, bob, alice);

      const asBob = await as(app, bob).get(`/api/v1/users/${alice.userId}`);
      expect(asBob.status).toBe(200);
      expect(asBob.body).toEqual({ id: alice.userId, displayName: "Alice", avatarUrl: null, statusMessage: "Busy", bio: "Loves compilers" });

      const asStranger = await as(app, stranger).get(`/api/v1/users/${alice.userId}`);
      expect(asStranger.status).toBe(200);
      expect(asStranger.body).not.toHaveProperty("bio");
      expect(asStranger.body).not.toHaveProperty("email");

      const self = await as(app, alice).get(`/api/v1/users/${alice.userId}`);
      expect(self.body.bio).toBe("Loves compilers");
    });

    it("stops showing the bio once the only shared group has been left", async () => {
      const alice = await signupTestUser(app, { displayName: "Alice", email: "alice@example.com" });
      const carol = await signupTestUser(app, { displayName: "Carol", email: "carol@example.com" });
      await as(app, alice).patch("/api/v1/users/me").send({ bio: "Private-ish" });
      const { groupId } = await createGroup(app, alice, [carol]);

      expect((await as(app, carol).get(`/api/v1/users/${alice.userId}`)).body.bio).toBe("Private-ish");
      expect((await as(app, carol).post(`/api/v1/groups/${groupId}/leave`)).status).toBe(200);
      expect((await as(app, carol).get(`/api/v1/users/${alice.userId}`)).body).not.toHaveProperty("bio");
    });

    it("returns 404 for an unknown user and 400 for a malformed id", async () => {
      const alice = await signupTestUser(app);
      expect((await as(app, alice).get("/api/v1/users/00000000-0000-4000-8000-000000000000")).status).toBe(404);
      expect((await as(app, alice).get("/api/v1/users/not-a-uuid")).status).toBe(400);
    });
  });
});
