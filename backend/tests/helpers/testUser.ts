import type { Express } from "express";
import request from "supertest";

export interface TestUser {
  userId: string;
  accessToken: string;
  email: string;
  displayName: string;
}

let counter = 0;

export async function signupTestUser(app: Express, overrides: Partial<TestUser> & { password?: string } = {}): Promise<TestUser> {
  counter += 1;
  const payload = {
    email: overrides.email ?? `user${counter}@example.com`,
    password: overrides.password ?? "Passw0rd!",
    displayName: overrides.displayName ?? `Test User ${counter}`,
  };

  const res = await request(app).post("/api/v1/auth/signup").send(payload);
  if (res.status !== 201) {
    throw new Error(`signupTestUser failed: ${res.status} ${JSON.stringify(res.body)}`);
  }

  return {
    userId: res.body.user.id as string,
    accessToken: res.body.tokens.accessToken as string,
    email: payload.email,
    displayName: payload.displayName,
  };
}
