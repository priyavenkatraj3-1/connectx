import request from "supertest";
import type { Express } from "express";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { createTestDb } from "../helpers/testDb";

describe("Auth API", () => {
  let app: Express;

  beforeEach(async () => {
    const db = await createTestDb();
    app = createApp({ db }).app;
  });

  const validSignup = {
    email: "newuser@example.com",
    password: "Passw0rd!",
    displayName: "New User",
  };

  it("signs up a new user and returns tokens", async () => {
    const res = await request(app).post("/api/v1/auth/signup").send(validSignup);
    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe(validSignup.email);
    expect(res.body.tokens.accessToken).toBeTypeOf("string");
    expect(res.body.tokens.refreshToken).toBeTypeOf("string");
  });

  it("rejects signup with a weak password", async () => {
    const res = await request(app)
      .post("/api/v1/auth/signup")
      .send({ ...validSignup, password: "weak" });
    expect(res.status).toBe(400);
  });

  it("rejects duplicate signup for the same email", async () => {
    await request(app).post("/api/v1/auth/signup").send(validSignup);
    const res = await request(app).post("/api/v1/auth/signup").send(validSignup);
    expect(res.status).toBe(409);
  });

  it("logs in with correct credentials", async () => {
    await request(app).post("/api/v1/auth/signup").send(validSignup);
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: validSignup.email, password: validSignup.password });
    expect(res.status).toBe(200);
    expect(res.body.tokens.accessToken).toBeTypeOf("string");
  });

  it("rejects login with wrong password", async () => {
    await request(app).post("/api/v1/auth/signup").send(validSignup);
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: validSignup.email, password: "WrongPass1" });
    expect(res.status).toBe(401);
  });

  it("blocks access to a protected route without a token", async () => {
    const res = await request(app).get("/api/v1/users/me");
    expect(res.status).toBe(401);
  });

  it("allows access to a protected route with a valid token", async () => {
    const signupRes = await request(app).post("/api/v1/auth/signup").send(validSignup);
    const token = signupRes.body.tokens.accessToken as string;

    const res = await request(app).get("/api/v1/users/me").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(signupRes.body.user.id);
  });
});
