import type { Express } from "express";
import request from "supertest";
import type { TestUser } from "./testUser";

/** Minimal byte sequences that pass magic-byte validation for each type. */
export const SAMPLE_FILES = {
  png: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]),
  jpg: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 1)]),
  pdf: Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n"),
  mp4: Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from("ftypmp42"), Buffer.alloc(16, 0)]),
  ogg: Buffer.concat([Buffer.from("OggS"), Buffer.alloc(32, 0)]),
  txt: Buffer.from("hello, plain text\n"),
  /** A Windows executable header — must never be accepted, whatever it's named. */
  exe: Buffer.concat([Buffer.from("MZ"), Buffer.alloc(64, 0x90)]),
};

export async function createGroup(
  app: Express,
  owner: TestUser,
  members: TestUser[],
  name = "Test Group"
): Promise<{ groupId: string; conversationId: string }> {
  const res = await request(app)
    .post("/api/v1/groups")
    .set("Authorization", `Bearer ${owner.accessToken}`)
    .send({ name, memberIds: members.map((m) => m.userId) });
  if (res.status !== 201) {
    throw new Error(`createGroup failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { groupId: res.body.group.id as string, conversationId: res.body.group.conversationId as string };
}

export async function createDirectConversation(app: Express, user: TestUser, other: TestUser): Promise<string> {
  const res = await request(app)
    .post("/api/v1/conversations/direct")
    .set("Authorization", `Bearer ${user.accessToken}`)
    .send({ userId: other.userId });
  if (res.status !== 200) {
    throw new Error(`createDirectConversation failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.conversation.id as string;
}

export function sendMessage(app: Express, user: TestUser, conversationId: string, payload: Record<string, unknown>) {
  return request(app)
    .post(`/api/v1/messages/${conversationId}`)
    .set("Authorization", `Bearer ${user.accessToken}`)
    .send(payload);
}

/** Uploads status media (POST /media?purpose=status). */
export function uploadStatusMedia(app: Express, user: TestUser, filename: string, data: Buffer, mimeType?: string) {
  const query = new URLSearchParams({ purpose: "status", filename, ...(mimeType ? { mimeType } : {}) });
  return request(app)
    .post(`/api/v1/media?${query.toString()}`)
    .set("Authorization", `Bearer ${user.accessToken}`)
    .set("Content-Type", "application/octet-stream")
    .send(data);
}

export function uploadFile(
  app: Express,
  user: TestUser,
  conversationId: string,
  filename: string,
  data: Buffer,
  mimeType?: string
) {
  const query = new URLSearchParams({ conversationId, filename, ...(mimeType ? { mimeType } : {}) });
  return request(app)
    .post(`/api/v1/media?${query.toString()}`)
    .set("Authorization", `Bearer ${user.accessToken}`)
    .set("Content-Type", "application/octet-stream")
    .send(data);
}
