import type { Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { createTestDb } from "../helpers/testDb";
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
});
