import type { Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import type { Container } from "../../src/container";
import { AVATAR_MAX_BYTES } from "../../src/modules/users/users.service";
import { as } from "../helpers/api";
import { FakeRealtimeGateway } from "../helpers/fakeRealtimeGateway";
import { createDirectConversation, SAMPLE_FILES } from "../helpers/fixtures";
import { MemoryStorageProvider } from "../helpers/memoryStorage";
import { createTestDb } from "../helpers/testDb";
import { signupTestUser, type TestUser } from "../helpers/testUser";

const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 "), Buffer.alloc(16, 1)]);
const AVATAR_PATH = /^\/api\/v1\/users\/[0-9a-f-]{36}\/avatar\/([0-9a-f-]{36})$/;

describe("Profile pictures API", () => {
  let app: Express;
  let container: Container;
  let storage: MemoryStorageProvider;
  let gateway: FakeRealtimeGateway;
  let alice: TestUser;
  let bob: TestUser;
  let eve: TestUser;

  const upload = (user: TestUser, data: Buffer, contentType = "application/octet-stream") =>
    as(app, user).put("/api/v1/users/me/avatar").set("Content-Type", contentType).send(data);
  const avatarKeys = () => [...storage.files.keys()].filter((k) => k.startsWith("avatars/"));

  beforeEach(async () => {
    storage = new MemoryStorageProvider();
    ({ app, container } = createApp({ db: await createTestDb(), storage }));
    gateway = new FakeRealtimeGateway();
    container.realtimeGatewayRef.current = gateway;
    alice = await signupTestUser(app, { displayName: "Alice", email: "alice@example.com" });
    bob = await signupTestUser(app, { displayName: "Bob", email: "bob@example.com" });
    eve = await signupTestUser(app, { displayName: "Eve", email: "eve@example.com" });
  });

  it("uploads a picture for the signed-in user and serves it to anyone with the URL, safely", async () => {
    const res = await upload(alice, SAMPLE_FILES.png);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(alice.userId);
    expect(res.body.avatarUrl).toMatch(AVATAR_PATH);
    expect(res.body.avatarUrl.startsWith(`/api/v1/users/${alice.userId}/`)).toBe(true);
    expect(avatarKeys()).toEqual([`avatars/${alice.userId}/${AVATAR_PATH.exec(res.body.avatarUrl)![1]}`]);

    // No token needed (an <img> can't send one).
    const image = await request(app).get(res.body.avatarUrl).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(image.status).toBe(200);
    expect(image.headers["content-type"]).toBe("image/png");
    expect(Buffer.compare(image.body as Buffer, SAMPLE_FILES.png)).toBe(0);
    expect(image.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(image.headers["content-security-policy"]).toContain("sandbox");
    expect(image.headers["x-content-type-options"]).toBe("nosniff");
    expect(image.headers["cache-control"]).toContain("immutable");
  });

  it("decides the type from the bytes: JPEG, PNG and WebP only", async () => {
    expect((await upload(alice, SAMPLE_FILES.jpg)).status).toBe(200);
    expect((await upload(alice, WEBP, "image/webp")).status).toBe(200);

    const gif = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(16, 0)]);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');
    for (const [label, data, type] of [
      ["exe declared as png", SAMPLE_FILES.exe, "image/png"],
      ["svg", svg, "image/svg+xml"],
      ["html", Buffer.from("<html><script>alert(1)</script></html>"), "text/html"],
      ["gif", gif, "image/gif"],
      ["pdf", SAMPLE_FILES.pdf, "application/pdf"],
    ] as const) {
      const res = await upload(alice, data, type);
      expect(res.status, label).toBe(415);
    }
    expect((await upload(alice, Buffer.alloc(0))).status).toBe(400);
    const tooBig = Buffer.concat([SAMPLE_FILES.png, Buffer.alloc(AVATAR_MAX_BYTES, 1)]);
    const big = await upload(alice, tooBig);
    expect(big.status).toBe(413);
    expect(big.body.error.message).toBe("Profile pictures can be at most 2MB");
  });

  it("replacing or removing a picture stops serving the old one and deletes its bytes", async () => {
    const first = (await upload(alice, SAMPLE_FILES.png)).body.avatarUrl as string;
    const second = (await upload(alice, SAMPLE_FILES.jpg)).body.avatarUrl as string;
    expect(second).not.toBe(first);
    expect((await request(app).get(first)).status).toBe(404);
    expect((await request(app).get(second)).status).toBe(200);
    expect(avatarKeys()).toHaveLength(1);

    const removed = await as(app, alice).delete("/api/v1/users/me/avatar");
    expect(removed.status).toBe(200);
    expect(removed.body.avatarUrl).toBeNull();
    expect((await request(app).get(second)).status).toBe(404);
    expect(avatarKeys()).toEqual([]);
  });

  it("switching to an external URL also removes the uploaded picture", async () => {
    await upload(alice, SAMPLE_FILES.png);
    const res = await as(app, alice).patch("/api/v1/users/me").send({ avatarUrl: "https://images.example.com/alice.png" });
    expect(res.status).toBe(200);
    expect(avatarKeys()).toEqual([]);
    // …and the server-only path form can't be set by hand.
    const forged = await as(app, alice).patch("/api/v1/users/me").send({ avatarUrl: `/api/v1/users/${bob.userId}/avatar/00000000-0000-4000-8000-000000000000` });
    expect(forged.status).toBe(400);
  });

  it("nobody can change or remove someone else's picture", async () => {
    const bobs = (await upload(bob, SAMPLE_FILES.png)).body.avatarUrl as string;

    // Writes only ever target the token's user; there is no per-user write route.
    expect((await as(app, eve).put(`/api/v1/users/${bob.userId}/avatar`).set("Content-Type", "image/png").send(SAMPLE_FILES.jpg)).status).toBe(404);
    expect((await as(app, eve).delete(`/api/v1/users/${bob.userId}/avatar`)).status).toBe(404);
    expect((await request(app).put("/api/v1/users/me/avatar").set("Content-Type", "image/png").send(SAMPLE_FILES.png)).status).toBe(401);
    expect((await request(app).delete("/api/v1/users/me/avatar")).status).toBe(401);

    // Eve uploading her own picture never touches Bob's.
    await upload(eve, SAMPLE_FILES.jpg);
    expect((await as(app, eve).get(`/api/v1/users/${bob.userId}`)).body.avatarUrl).toBe(bobs);
    expect((await request(app).get(bobs)).status).toBe(200);
  });

  it("only serves a user's current picture: wrong IDs are 404, malformed ones 400", async () => {
    const url = (await upload(alice, SAMPLE_FILES.png)).body.avatarUrl as string;
    const avatarId = AVATAR_PATH.exec(url)![1];
    expect((await request(app).get(`/api/v1/users/${bob.userId}/avatar/${avatarId}`)).status).toBe(404);
    expect((await request(app).get(`/api/v1/users/${alice.userId}/avatar/00000000-0000-4000-8000-000000000000`)).status).toBe(404);
    expect((await request(app).get(`/api/v1/users/${alice.userId}/avatar/not-a-uuid`)).status).toBe(400);
    expect((await request(app).get(`/api/v1/users/${alice.userId}/avatar/..%2F..%2Fsecret`)).status).toBe(400);
  });

  it("tells your devices and the people you chat with — nobody else — and their lists show it", async () => {
    await createDirectConversation(app, alice, bob);
    gateway.sentEvents.length = 0;
    const url = (await upload(alice, SAMPLE_FILES.png)).body.avatarUrl as string;

    const notified = gateway.sentEvents.filter((e) => e.event.type === "user:updated");
    expect(notified.map((e) => e.userId).sort()).toEqual([alice.userId, bob.userId].sort());
    expect(notified[0]!.event).toEqual({ type: "user:updated", user: { id: alice.userId, displayName: "Alice", avatarUrl: url, statusMessage: null } });

    const list = await as(app, bob).get("/api/v1/conversations");
    expect(list.body.conversations[0].otherParticipant.avatarUrl).toBe(url);
    expect((await as(app, bob).get(`/api/v1/users/${alice.userId}`)).body.avatarUrl).toBe(url);
  });
});
