import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { FakeRealtimeGateway } from "../helpers/fakeRealtimeGateway";
import { createGroup } from "../helpers/fixtures";
import { createTestDb } from "../helpers/testDb";
import { signupTestUser, type TestUser } from "../helpers/testUser";

// Own file (and own database): the real-PostgreSQL test mode allows one test database per file.
describe("Group calls", () => {
  it("refuses to let more than the maximum number of participants join", async () => {
    const db = await createTestDb();
    const capGateway = new FakeRealtimeGateway();
    const small = createApp({ db, realtimeGateway: capGateway, callMaxMeshParticipants: 2 });
    const [owner, m1, m2] = [
      await signupTestUser(small.app),
      await signupTestUser(small.app),
      await signupTestUser(small.app),
    ];
    const conn = (u: TestUser) => ({ userId: u.userId, connectionId: `00000000-0000-4000-8000-${u.userId.slice(-12)}` });
    for (const u of [owner, m1, m2]) capGateway.openConnections.add(`${u.userId}:${conn(u).connectionId}`);

    const { conversationId } = await createGroup(small.app, owner, [m1, m2]);
    const call = await small.container.callsService.startCall(owner.userId, {
      conversationId,
      media: "video",
      connectionId: conn(owner).connectionId,
    });
    await small.container.callsService.accept(conn(m1), call.id);
    await expect(small.container.callsService.accept(conn(m2), call.id)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringMatching(/full/),
    });
    small.container.callsService.dispose();
  });
});
