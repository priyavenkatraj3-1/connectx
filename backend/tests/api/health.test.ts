import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { createTestDb } from "../helpers/testDb";

describe("GET /health", () => {
  it("returns 200 and an ok status", async () => {
    const db = await createTestDb();
    const { app } = createApp({ db });
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", service: "connectx-backend" });
  });
});
