import type { Express } from "express";
import request from "supertest";
import type { TestUser } from "./testUser";

/** Shorthand for authenticated requests: `as(app, alice).post("/api/v1/tasks").send({...})`. */
export function as(app: Express, user: TestUser) {
  const auth = `Bearer ${user.accessToken}`;
  return {
    get: (url: string) => request(app).get(url).set("Authorization", auth),
    post: (url: string) => request(app).post(url).set("Authorization", auth),
    put: (url: string) => request(app).put(url).set("Authorization", auth),
    patch: (url: string) => request(app).patch(url).set("Authorization", auth),
    delete: (url: string) => request(app).delete(url).set("Authorization", auth),
  };
}

/** An ISO timestamp `minutes` from now. */
export function minutesFromNow(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}
