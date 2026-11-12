import type { Express } from "express";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { SEARCH_RESULT_LIMIT } from "../../src/modules/messages/messages.service";
import { as } from "../helpers/api";
import { createDirectConversation, createGroup, sendMessage } from "../helpers/fixtures";
import { createTestDb } from "../helpers/testDb";
import { signupTestUser, type TestUser } from "../helpers/testUser";

describe("In-chat message search API", () => {
  let app: Express;
  let alice: TestUser;
  let bob: TestUser;
  let eve: TestUser;
  let conversationId: string;

  const search = (user: TestUser, convId: string, q: string) =>
    as(app, user).get(`/api/v1/messages/${convId}/search?q=${encodeURIComponent(q)}`);
  const bodies = (res: { body: { results: Array<{ body: string }> } }) => res.body.results.map((m) => m.body);

  beforeEach(async () => {
    const db = await createTestDb();
    app = createApp({ db }).app;
    alice = await signupTestUser(app, { displayName: "Alice", email: "alice@example.com" });
    bob = await signupTestUser(app, { displayName: "Bob", email: "bob@example.com" });
    eve = await signupTestUser(app, { displayName: "Eve", email: "eve@example.com" });
    conversationId = await createDirectConversation(app, alice, bob);
  });

  it("finds messages containing the text, case-insensitively, newest first", async () => {
    await sendMessage(app, alice, conversationId, { body: "Project kickoff on Monday" });
    await sendMessage(app, bob, conversationId, { body: "unrelated" });
    await sendMessage(app, bob, conversationId, { body: "The PROJECT doc is ready" });

    const res = await search(bob, conversationId, "project");
    expect(res.status).toBe(200);
    expect(bodies(res)).toEqual(["The PROJECT doc is ready", "Project kickoff on Monday"]);
    expect(res.body.results[0]).toMatchObject({ conversationId, senderId: bob.userId, reactions: [] });
  });

  it("doesn't return deleted messages, messages from other chats, or history from before you joined", async () => {
    const deleted = (await sendMessage(app, alice, conversationId, { body: "secret plan v1" })).body.message.id;
    await sendMessage(app, alice, conversationId, { body: "secret plan v2" });
    await as(app, alice).delete(`/api/v1/messages/${conversationId}/${deleted}`);
    const other = await createDirectConversation(app, alice, eve);
    await sendMessage(app, alice, other, { body: "secret for Eve only" });

    expect(bodies(await search(bob, conversationId, "secret"))).toEqual(["secret plan v2"]);

    const { groupId, conversationId: group } = await createGroup(app, alice, [bob]);
    await sendMessage(app, alice, group, { body: "budget before Eve joined" });
    await as(app, alice).post(`/api/v1/groups/${groupId}/members`).send({ userIds: [eve.userId] });
    await sendMessage(app, alice, group, { body: "budget after Eve joined" });
    expect(bodies(await search(eve, group, "budget"))).toEqual(["budget after Eve joined"]);
  });

  it("refuses people who aren't members", async () => {
    await sendMessage(app, alice, conversationId, { body: "hello" });
    expect((await search(eve, conversationId, "hello")).status).toBe(403);
  });

  it("treats % and _ as literal characters, not wildcards", async () => {
    await sendMessage(app, alice, conversationId, { body: "100% done" });
    await sendMessage(app, alice, conversationId, { body: "file_name.txt" });
    await sendMessage(app, alice, conversationId, { body: "filename.txt" });
    await sendMessage(app, alice, conversationId, { body: "back\\slash" });

    expect(bodies(await search(bob, conversationId, "%"))).toEqual(["100% done"]);
    expect(bodies(await search(bob, conversationId, "file_"))).toEqual(["file_name.txt"]);
    expect(bodies(await search(bob, conversationId, "\\"))).toEqual(["back\\slash"]);
  });

  it("validates the query and caps the number of results", async () => {
    expect((await search(bob, conversationId, "")).status).toBe(400);
    expect((await search(bob, conversationId, "   ")).status).toBe(400);
    expect((await search(bob, conversationId, "x".repeat(101))).status).toBe(400);
    expect((await as(app, bob).get("/api/v1/messages/not-a-uuid/search?q=hi")).status).toBe(400);

    for (let i = 0; i < SEARCH_RESULT_LIMIT + 3; i++) await sendMessage(app, alice, conversationId, { body: `note ${i}` });
    const res = await search(bob, conversationId, "note");
    expect(res.body.results).toHaveLength(SEARCH_RESULT_LIMIT);
    expect(res.body.results[0].body).toBe(`note ${SEARCH_RESULT_LIMIT + 2}`);
  });
});
