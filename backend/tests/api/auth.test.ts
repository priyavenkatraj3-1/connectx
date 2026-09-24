import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app";

describe("Auth API", () => {
  const app = createApp();

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
      .send({ ...validSignup, email: "weak@example.com", password: "weak" });
    expect(res.status).toBe(400);
  });

  it("rejects duplicate signup for the same email", async () => {
    await request(app).post("/api/v1/auth/signup").send({ ...validSignup, email: "dupe@example.com" });
    const res = await request(app).post("/api/v1/auth/signup").send({ ...validSignup, email: "dupe@example.com" });
    expect(res.status).toBe(409);
  });

  it("logs in with correct credentials", async () => {
    await request(app).post("/api/v1/auth/signup").send({ ...validSignup, email: "login@example.com" });
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "login@example.com", password: validSignup.password });
    expect(res.status).toBe(200);
    expect(res.body.tokens.accessToken).toBeTypeOf("string");
  });

  it("rejects login with wrong password", async () => {
    await request(app).post("/api/v1/auth/signup").send({ ...validSignup, email: "wrongpw@example.com" });
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "wrongpw@example.com", password: "WrongPass1" });
    expect(res.status).toBe(401);
  });

  it("blocks access to a protected route without a token", async () => {
    const res = await request(app).get("/api/v1/users/me");
    expect(res.status).toBe(401);
  });

  it("allows access to a protected route with a valid token", async () => {
    const signupRes = await request(app)
      .post("/api/v1/auth/signup")
      .send({ ...validSignup, email: "protected@example.com" });
    const token = signupRes.body.tokens.accessToken as string;

    const res = await request(app).get("/api/v1/users/me").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(signupRes.body.user.id);
  });
});
