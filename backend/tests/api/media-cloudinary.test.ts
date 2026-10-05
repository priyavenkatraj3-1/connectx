import type { Express } from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { CloudinaryStorageProvider } from "../../src/modules/media/storage/cloudinary.storage";
import { FakeCloudinary } from "../helpers/fakeCloudinary";
import { createGroup, SAMPLE_FILES, sendMessage, uploadFile } from "../helpers/fixtures";
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

/** The existing media flow, end to end, with Cloudinary as the storage provider. */
describe("Media API on Cloudinary storage", () => {
  let app: Express;
  let cloud: FakeCloudinary;
  let alice: TestUser;
  let bob: TestUser;
  let eve: TestUser;
  let conversationId: string;

  beforeAll(async () => {
    const db = await createTestDb();
    cloud = new FakeCloudinary();
    const storage = new CloudinaryStorageProvider(cloud.client, "connectx", cloud.fetch);
    ({ app } = createApp({ db, storage, maxUploadBytes: 64 * 1024 }));
    alice = await signupTestUser(app, { displayName: "Alice" });
    bob = await signupTestUser(app, { displayName: "Bob" });
    eve = await signupTestUser(app, { displayName: "Eve" });
  });

  beforeEach(async () => {
    ({ conversationId } = await createGroup(app, alice, [bob]));
  });

  it("stores uploads as private assets and serves the exact bytes only to members", async () => {
    const upload = await uploadFile(app, alice, conversationId, "report.pdf", SAMPLE_FILES.pdf);
    expect(upload.status).toBe(201);
    expect(upload.body.attachment).not.toHaveProperty("storageKey");
    const attachmentId = upload.body.attachment.id as string;

    const asset = cloud.assets.get(`connectx/${conversationId}/${attachmentId}`);
    expect(asset).toMatchObject({ resourceType: "raw", type: "authenticated" });

    await sendMessage(app, alice, conversationId, { attachmentId });
    const res = await request(app).get(`/api/v1/media/${attachmentId}/content`).set(auth(bob)).buffer(true).parse(binaryParser);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect((res.body as Buffer).equals(SAMPLE_FILES.pdf)).toBe(true);

    expect((await request(app).get(`/api/v1/media/${attachmentId}/content`).set(auth(eve))).status).toBe(403);
    expect((await request(app).get(`/api/v1/media/${attachmentId}/content`)).status).toBe(401);
  });

  it("validates file type and content before anything reaches Cloudinary", async () => {
    const before = cloud.calls.length;
    expect((await uploadFile(app, alice, conversationId, "evil.exe", SAMPLE_FILES.exe)).status).toBe(415);
    expect((await uploadFile(app, alice, conversationId, "cat.png", SAMPLE_FILES.exe)).status).toBe(415);
    expect((await uploadFile(app, alice, conversationId, "cat.png", SAMPLE_FILES.png, "text/html")).status).toBe(415);
    expect(cloud.calls.length).toBe(before);
  });

  it("deleting an unsent upload removes the Cloudinary asset", async () => {
    const upload = await uploadFile(app, alice, conversationId, "photo.png", SAMPLE_FILES.png);
    const attachmentId = upload.body.attachment.id as string;

    expect((await request(app).delete(`/api/v1/media/${attachmentId}`).set(auth(alice))).status).toBe(204);
    expect(cloud.assets.has(`connectx/${conversationId}/${attachmentId}`)).toBe(false);
  });

  it("deleting a media message removes the Cloudinary asset", async () => {
    const upload = await uploadFile(app, alice, conversationId, "gone.png", SAMPLE_FILES.png);
    const attachmentId = upload.body.attachment.id as string;
    const sent = await sendMessage(app, alice, conversationId, { attachmentId });

    await request(app).delete(`/api/v1/messages/${conversationId}/${sent.body.message.id}`).set(auth(alice));

    expect(cloud.assets.has(`connectx/${conversationId}/${attachmentId}`)).toBe(false);
    expect((await request(app).get(`/api/v1/media/${attachmentId}`).set(auth(alice))).status).toBe(404);
  });

  it("reports content missing from Cloudinary as unavailable (404), not a server error", async () => {
    const upload = await uploadFile(app, alice, conversationId, "lost.png", SAMPLE_FILES.png);
    const attachmentId = upload.body.attachment.id as string;
    await sendMessage(app, alice, conversationId, { attachmentId });
    cloud.assets.delete(`connectx/${conversationId}/${attachmentId}`);

    expect((await request(app).get(`/api/v1/media/${attachmentId}/content`).set(auth(bob))).status).toBe(404);
  });
});
