import express, { type Request } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { env, productionConfigProblems, type EnvConfig } from "../../src/config/env";
import { errorHandler } from "../../src/middleware/errorHandler";
import { createUserRateLimiter } from "../../src/middleware/rateLimiter";
import { redactUrl } from "../../src/utils/logger";

/** Phase 7: limiter behavior, production configuration guard, log redaction, DB-error mapping. */

function appWithLimiter(max: number) {
  const app = express();
  // Stand-in for requireAuth: the limiter keys on req.user.
  app.use((req, _res, next) => {
    const userId = req.header("x-user");
    if (userId) (req as Request & { user?: { userId: string } }).user = { userId };
    next();
  });
  app.post("/thing", createUserRateLimiter({ windowMs: 60_000, max, message: "Slow down" }), (_req, res) => {
    res.status(201).json({ ok: true });
  });
  return app;
}

describe("createUserRateLimiter", () => {
  it("limits each user independently and answers 429 with the standard error envelope", async () => {
    const app = appWithLimiter(2);
    for (let i = 0; i < 2; i += 1) expect((await request(app).post("/thing").set("x-user", "alice")).status).toBe(201);
    const limited = await request(app).post("/thing").set("x-user", "alice");
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: { message: "Slow down", code: "rate_limited" } });
    expect(limited.headers["ratelimit-limit"]).toBe("2");

    // Bob (e.g. behind the same NAT/IP) is unaffected by Alice's usage.
    expect((await request(app).post("/thing").set("x-user", "bob")).status).toBe(201);
  });

  it("falls back to the client IP for unauthenticated requests", async () => {
    const app = appWithLimiter(1);
    expect((await request(app).post("/thing")).status).toBe(201);
    expect((await request(app).post("/thing")).status).toBe(429);
    expect((await request(app).post("/thing").set("x-user", "carol")).status).toBe(201);
  });

  it("creates independent counters per limiter", async () => {
    const a = appWithLimiter(1);
    const b = appWithLimiter(1);
    expect((await request(a).post("/thing").set("x-user", "dave")).status).toBe(201);
    expect((await request(b).post("/thing").set("x-user", "dave")).status).toBe(201);
  });
});

describe("productionConfigProblems", () => {
  const good: EnvConfig = {
    ...env,
    nodeEnv: "production",
    clientOrigins: ["https://chat.example.com"],
    bcryptSaltRounds: 12,
    jwt: { ...env.jwt, accessSecret: "a".repeat(48), refreshSecret: "b".repeat(48) },
  };

  it("accepts a safe configuration", () => {
    expect(productionConfigProblems(good)).toEqual([]);
  });

  it("flags short, placeholder and shared JWT secrets", () => {
    const problems = productionConfigProblems({
      ...good,
      jwt: { ...good.jwt, accessSecret: "replace-with-a-long-random-secret", refreshSecret: "replace-with-a-long-random-secret" },
    });
    expect(problems.join("\n")).toMatch(/JWT_ACCESS_SECRET still looks like a placeholder/);
    expect(problems.join("\n")).toMatch(/must be different/);
    expect(productionConfigProblems({ ...good, jwt: { ...good.jwt, accessSecret: "short" } }).join("\n")).toMatch(/at least 32 characters/);
  });

  it("flags wildcard/missing CORS origins and weak bcrypt cost", () => {
    expect(productionConfigProblems({ ...good, clientOrigins: ["*"] })).toContain("CLIENT_ORIGIN must not be *");
    expect(productionConfigProblems({ ...good, clientOrigins: [] })).toContain("CLIENT_ORIGIN must list the frontend's origin");
    expect(productionConfigProblems({ ...good, bcryptSaltRounds: 8 })).toContain("BCRYPT_SALT_ROUNDS must be at least 10");
  });
});

describe("redactUrl", () => {
  it("masks passwords in connection strings and leaves other text alone", () => {
    expect(redactUrl("postgresql://connectx:s3cr3t@db.internal:5432/connectx")).toBe("postgresql://connectx:****@db.internal:5432/connectx");
    expect(redactUrl("connect ECONNREFUSED postgres://u:p@h/db and more")).toBe("connect ECONNREFUSED postgres://u:****@h/db and more");
    expect(redactUrl("postgresql://localhost/connectx")).toBe("postgresql://localhost/connectx");
  });
});

describe("errorHandler", () => {
  function appThrowing(err: unknown) {
    const app = express();
    app.get("/", () => {
      throw err;
    });
    app.use(errorHandler);
    return app;
  }

  it("turns PostgreSQL data exceptions (bad UUID, out-of-range values) into a generic 400", async () => {
    const pgError = Object.assign(new Error('invalid input syntax for type uuid: "nope"'), { code: "22P02" });
    const res = await request(appThrowing(pgError)).get("/");
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain("uuid");
  });

  it("hides internal error details behind a generic 500", async () => {
    const { setLogLevel } = await import("../../src/utils/logger");
    setLogLevel("silent");
    const res = await request(appThrowing(new Error("relation users does not exist at /srv/app"))).get("/");
    setLogLevel("error");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { message: "Internal server error" } });
  });
});
