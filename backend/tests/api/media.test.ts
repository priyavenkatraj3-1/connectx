import type { Express } from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { env } from "../../src/config/env";
import type { Container } from "../../src/container";
import { createGroup, SAMPLE_FILES, sendMessage, uploadFile } from "../helpers/fixtures";
import { MemoryStorageProvider } from "../helpers/memoryStorage";
import { createTestDb } from "../helpers/testDb";
import { signupTestUser, type TestUser } from "../helpers/testUser";

function auth(user: TestUser) {
  return { Authorization: `Bearer ${user.accessToken}` };
}

/** supertest doesn't buffer arbitrary binary responses by default. */
function binaryParser(res: NodeJS.ReadableStream & { setEncoding(e: string): void }, cb: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on("data", (chunk: Buffer) => chunks.push(chunk));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
}

const MAX_BYTES = 64 * 1024;

describe("Media API", () => {
  let app: Express;
  let container: Container;
  let storage: MemoryStorageProvider;
  let alice: TestUser;
  let bob: TestUser;
  let eve: TestUser;
  let conversationId: string;
  let groupId: string;

  beforeAll(async () => {
    const db = await createTestDb();
    storage = new MemoryStorageProvider();
    ({ app, container } = createApp({ db, storage, maxUploadBytes: MAX_BYTES }));
    alice = await signupTestUser(app, { displayName: "Alice" });
    bob = await signupTestUser(app, { displayName: "Bob" });
    eve = await signupTestUser(app, { displayName: "Eve" });
  });

  beforeEach(async () => {
    ({ conversationId, groupId } = await createGroup(app, alice, [bob]));
  });

  describe("upload", () => {
    it("stores a valid image and returns sanitized metadata (never the storage key)", async () => {
      const res = await uploadFile(app, alice, conversationId, "../../holiday.png", SAMPLE_FILES.png, "image/png");
      expect(res.status).toBe(201);
      expect(res.body.attachment).toMatchObject({
        conversationId,
        messageId: null,
        uploaderId: alice.userId,
        kind: "image",
        mimeType: "image/png",
        sizeBytes: SAMPLE_FILES.png.length,
        originalFilename: "holiday.png",
      });
      expect(res.body.attachment).not.toHaveProperty("storageKey");
      expect(storage.files.get(`${conversationId}/${res.body.attachment.id}`)).toEqual(SAMPLE_FILES.png);
    });

    it("rejects unsupported types, spoofed contents and contradicting declared types with 415", async () => {
      const storedBefore = storage.files.size;
      expect((await uploadFile(app, alice, conversationId, "evil.exe", SAMPLE_FILES.exe)).status).toBe(415);
      expect((await uploadFile(app, alice, conversationId, "evil.svg", Buffer.from("<svg onload=alert(1)>"))).status).toBe(415);
      expect((await uploadFile(app, alice, conversationId, "cat.png", SAMPLE_FILES.exe)).status).toBe(415);
      expect((await uploadFile(app, alice, conversationId, "cat.png", SAMPLE_FILES.png, "text/html")).status).toBe(415);
      expect(storage.files.size).toBe(storedBefore); // nothing written for rejected uploads
    });

    it("rejects files over the size limit with 413 and empty files with 400", async () => {
      const big = Buffer.concat([SAMPLE_FILES.png, Buffer.alloc(MAX_BYTES)]);
      const tooBig = await uploadFile(app, alice, conversationId, "big.png", big);
      expect(tooBig.status).toBe(413);
      expect(tooBig.body.error.message).toMatch(/maximum size/);

      expect((await uploadFile(app, alice, conversationId, "empty.png", Buffer.alloc(0))).status).toBe(400);
    });

    it("requires membership of the target conversation, authentication and valid parameters", async () => {
      expect((await uploadFile(app, eve, conversationId, "a.png", SAMPLE_FILES.png)).status).toBe(403);
      expect(
        (await request(app).post(`/api/v1/media?conversationId=${conversationId}&filename=a.png`).send(SAMPLE_FILES.png)).status
      ).toBe(401);
      expect((await uploadFile(app, alice, "not-a-uuid", "a.png", SAMPLE_FILES.png)).status).toBe(400);
    });
  });

  describe("media messages", () => {
    it("sends an attachment as a message with an optional caption and renders it for members", async () => {
      const upload = await uploadFile(app, alice, conversationId, "report.pdf", SAMPLE_FILES.pdf);
      const attachmentId = upload.body.attachment.id as string;

      const sent = await sendMessage(app, alice, conversationId, { attachmentId, body: "Q3 numbers" });
      expect(sent.status).toBe(201);
      expect(sent.body.message).toMatchObject({
        contentType: "file",
        body: "Q3 numbers",
        attachment: { id: attachmentId, kind: "document", originalFilename: "report.pdf", messageId: sent.body.message.id },
      });

      const history = await request(app).get(`/api/v1/messages/${conversationId}`).set(auth(bob));
      expect(history.body.items[0].attachment.id).toBe(attachmentId);

      const list = await request(app).get("/api/v1/conversations").set(auth(bob));
      const entry = list.body.conversations.find((c: { id: string }) => c.id === conversationId);
      expect(entry.lastMessage).toMatchObject({ contentType: "file", body: "Q3 numbers" });
    });

    it("maps each attachment kind to a message content type, caption optional", async () => {
      const cases: Array<[string, Buffer, string]> = [
        ["photo.jpg", SAMPLE_FILES.jpg, "image"],
        ["clip.mp4", SAMPLE_FILES.mp4, "video"],
        ["voice.ogg", SAMPLE_FILES.ogg, "audio"],
      ];
      for (const [name, data, contentType] of cases) {
        const upload = await uploadFile(app, alice, conversationId, name, data);
        const sent = await sendMessage(app, alice, conversationId, { attachmentId: upload.body.attachment.id });
        expect(sent.status).toBe(201);
        expect(sent.body.message).toMatchObject({ contentType, body: null });
      }
    });

    it("rejects attaching someone else's upload, an upload from another conversation, or the same upload twice", async () => {
      const bobUpload = await uploadFile(app, bob, conversationId, "b.png", SAMPLE_FILES.png);
      expect((await sendMessage(app, alice, conversationId, { attachmentId: bobUpload.body.attachment.id })).status).toBe(404);

      const { conversationId: otherConversation } = await createGroup(app, alice, [bob]);
      const elsewhere = await uploadFile(app, alice, otherConversation, "c.png", SAMPLE_FILES.png);
      expect((await sendMessage(app, alice, conversationId, { attachmentId: elsewhere.body.attachment.id })).status).toBe(400);

      const once = await uploadFile(app, alice, conversationId, "d.png", SAMPLE_FILES.png);
      expect((await sendMessage(app, alice, conversationId, { attachmentId: once.body.attachment.id })).status).toBe(201);
      expect((await sendMessage(app, alice, conversationId, { attachmentId: once.body.attachment.id })).status).toBe(409);
    });

    it("deleting a media message removes the attachment metadata and stored bytes", async () => {
      const upload = await uploadFile(app, alice, conversationId, "gone.png", SAMPLE_FILES.png);
      const attachmentId = upload.body.attachment.id as string;
      const sent = await sendMessage(app, alice, conversationId, { attachmentId });

      await request(app).delete(`/api/v1/messages/${conversationId}/${sent.body.message.id}`).set(auth(alice));

      expect(storage.files.has(`${conversationId}/${attachmentId}`)).toBe(false);
      expect((await request(app).get(`/api/v1/media/${attachmentId}`).set(auth(alice))).status).toBe(404);
    });
  });

  describe("download and access control", () => {
    it("serves sent media to members with safe headers, and refuses non-members", async () => {
      const upload = await uploadFile(app, alice, conversationId, "photo.png", SAMPLE_FILES.png);
      const attachmentId = upload.body.attachment.id as string;
      await sendMessage(app, alice, conversationId, { attachmentId });

      const res = await request(app)
        .get(`/api/v1/media/${attachmentId}/content`)
        .set(auth(bob))
        .buffer(true)
        .parse(binaryParser);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toBe("image/png");
      expect(res.headers["content-disposition"]).toMatch(/^inline; filename="photo.png"/);
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["cache-control"]).toBe("private, no-store");
      expect(res.body).toEqual(SAMPLE_FILES.png);

      expect((await request(app).get(`/api/v1/media/${attachmentId}/content`).set(auth(eve))).status).toBe(403);
      expect((await request(app).get(`/api/v1/media/${attachmentId}`).set(auth(eve))).status).toBe(403);
      expect((await request(app).get(`/api/v1/media/${attachmentId}/content`)).status).toBe(401);
    });

    it("rejects expired, forged and missing tokens for content (no bytes), and serves it again after a token refresh", async () => {
      const signup = await request(app)
        .post("/api/v1/auth/signup")
        .send({ email: `media-refresh-${Date.now()}@example.com`, password: "Passw0rd!", displayName: "Rae" });
      const rae = { userId: signup.body.user.id as string, sid: signup.body.session.id as string };
      const { conversationId: raeConversation } = await createGroup(app, alice, [
        { userId: rae.userId, accessToken: signup.body.tokens.accessToken, email: "", displayName: "Rae" },
      ]);
      const upload = await uploadFile(app, alice, raeConversation, "notes.pdf", SAMPLE_FILES.pdf);
      const attachmentId = upload.body.attachment.id as string;
      await sendMessage(app, alice, raeConversation, { attachmentId });
      const url = `/api/v1/media/${attachmentId}/content`;

      const expired = jwt.sign({ userId: rae.userId, sid: rae.sid, exp: Math.floor(Date.now() / 1000) - 60 }, env.jwt.accessSecret);
      const forged = jwt.sign({ userId: rae.userId, sid: rae.sid }, "not-the-server-secret");
      for (const token of [expired, forged]) {
        const res = await request(app).get(url).set("Authorization", `Bearer ${token}`);
        expect(res.status).toBe(401);
        // No session code: the client treats this as "refresh the access token and retry once".
        expect(res.body).toEqual({ error: { message: "Invalid or expired token" } });
        expect(res.headers["content-disposition"]).toBeUndefined();
      }
      const missing = await request(app).get(url);
      expect(missing.status).toBe(401);
      expect(missing.body).toEqual({ error: { message: "Authentication required" } });

      const refreshed = await request(app).post("/api/v1/auth/refresh").send({ refreshToken: signup.body.tokens.refreshToken });
      expect(refreshed.status).toBe(200);
      const res = await request(app)
        .get(url)
        .set("Authorization", `Bearer ${refreshed.body.tokens.accessToken as string}`)
        .buffer(true)
        .parse(binaryParser);
      expect(res.status).toBe(200);
      expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="notes.pdf"/);
      expect(res.body).toEqual(SAMPLE_FILES.pdf);
    });

    it("forces documents to download rather than render inline", async () => {
      const upload = await uploadFile(app, alice, conversationId, "report.pdf", SAMPLE_FILES.pdf);
      await sendMessage(app, alice, conversationId, { attachmentId: upload.body.attachment.id });
      const res = await request(app).get(`/api/v1/media/${upload.body.attachment.id}/content`).set(auth(bob));
      expect(res.headers["content-disposition"]).toMatch(/^attachment;/);
    });

    it("keeps an unsent upload private to its uploader", async () => {
      const upload = await uploadFile(app, alice, conversationId, "draft.png", SAMPLE_FILES.png);
      const attachmentId = upload.body.attachment.id as string;
      expect((await request(app).get(`/api/v1/media/${attachmentId}`).set(auth(alice))).status).toBe(200);
      expect((await request(app).get(`/api/v1/media/${attachmentId}`).set(auth(bob))).status).toBe(403);
    });

    it("revokes access when a member is removed, and hides media sent before a member joined", async () => {
      const upload = await uploadFile(app, alice, conversationId, "early.png", SAMPLE_FILES.png);
      const attachmentId = upload.body.attachment.id as string;
      await sendMessage(app, alice, conversationId, { attachmentId });

      await request(app).post(`/api/v1/groups/${groupId}/members`).set(auth(alice)).send({ userIds: [eve.userId] });
      expect((await request(app).get(`/api/v1/media/${attachmentId}`).set(auth(eve))).status).toBe(403);

      await request(app).delete(`/api/v1/groups/${groupId}/members/${bob.userId}`).set(auth(alice));
      expect((await request(app).get(`/api/v1/media/${attachmentId}/content`).set(auth(bob))).status).toBe(403);
    });

    it("returns 404 for unknown attachments and 400 for malformed IDs", async () => {
      expect((await request(app).get("/api/v1/media/00000000-0000-4000-8000-000000000000").set(auth(alice))).status).toBe(404);
      expect((await request(app).get("/api/v1/media/..%2F..%2Fetc%2Fpasswd").set(auth(alice))).status).toBe(400);
    });
  });

  describe("deletion", () => {
    it("lets only the uploader delete an unsent upload", async () => {
      const upload = await uploadFile(app, alice, conversationId, "draft.png", SAMPLE_FILES.png);
      const attachmentId = upload.body.attachment.id as string;

      expect((await request(app).delete(`/api/v1/media/${attachmentId}`).set(auth(bob))).status).toBe(403);
      expect((await request(app).delete(`/api/v1/media/${attachmentId}`).set(auth(alice))).status).toBe(204);
      expect(storage.files.has(`${conversationId}/${attachmentId}`)).toBe(false);
      expect((await request(app).get(`/api/v1/media/${attachmentId}`).set(auth(alice))).status).toBe(404);
    });

    it("refuses to delete an attachment that is part of a sent message", async () => {
      const upload = await uploadFile(app, alice, conversationId, "sent.png", SAMPLE_FILES.png);
      await sendMessage(app, alice, conversationId, { attachmentId: upload.body.attachment.id });
      expect((await request(app).delete(`/api/v1/media/${upload.body.attachment.id}`).set(auth(alice))).status).toBe(409);
    });
  });

  it("exposes the configured size limit to the container (sanity check)", () => {
    expect(container.maxUploadBytes).toBe(MAX_BYTES);
  });
});
