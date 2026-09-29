import type { Express } from "express";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { as } from "../helpers/api";
import { createTestDb } from "../helpers/testDb";
import { signupTestUser, type TestUser } from "../helpers/testUser";

const PROFILE = {
  businessName: "Priya's Bakery",
  description: "Fresh bread daily",
  category: "Food & drink",
  website: "https://bakery.example.com",
  contactEmail: "hello@bakery.example.com",
  contactPhone: "+44 20 7946 0000",
  address: "1 High St",
  businessHours: { mon: [{ open: "08:00", close: "17:00" }], sat: [{ open: "09:00", close: "13:00" }] },
};

describe("Business profile and quick replies (Phase 6)", () => {
  let app: Express;
  let owner: TestUser;
  let other: TestUser;

  beforeEach(async () => {
    ({ app } = createApp({ db: await createTestDb() }));
    owner = await signupTestUser(app, { displayName: "Priya" });
    other = await signupTestUser(app, { displayName: "Other" });
  });

  it("creates and updates a business profile that is always unverified", async () => {
    expect((await as(app, owner).get("/api/v1/business/profile")).body.profile).toBeNull();

    const created = await as(app, owner).put("/api/v1/business/profile").send(PROFILE);
    expect(created.status).toBe(200);
    expect(created.body.profile).toMatchObject({ ...PROFILE, verificationStatus: "unverified", isPublic: true, userId: owner.userId });

    const updated = await as(app, owner).put("/api/v1/business/profile").send({ ...PROFILE, businessName: "Priya's Bakery & Cafe" });
    expect(updated.body.profile.businessName).toBe("Priya's Bakery & Cafe");

    // The client cannot self-verify.
    expect((await as(app, owner).put("/api/v1/business/profile").send({ ...PROFILE, verificationStatus: "verified" })).status).toBe(400);
  });

  it("keeps the personal profile separate", async () => {
    await as(app, owner).put("/api/v1/business/profile").send(PROFILE);
    const me = await as(app, owner).get("/api/v1/users/me");
    expect(me.body.user?.displayName ?? me.body.profile?.displayName ?? me.body.displayName).toBe("Priya");
  });

  it("validates business fields", async () => {
    const put = (body: Record<string, unknown>) => as(app, owner).put("/api/v1/business/profile").send(body);
    expect((await put({ ...PROFILE, businessName: "" })).status).toBe(400);
    expect((await put({ ...PROFILE, website: "javascript:alert(1)" })).status).toBe(400);
    expect((await put({ ...PROFILE, contactEmail: "nope" })).status).toBe(400);
    expect((await put({ ...PROFILE, businessHours: { mon: [{ open: "18:00", close: "09:00" }] } })).status).toBe(400);
    expect((await put({ ...PROFILE, businessHours: { funday: [] } })).status).toBe(400);
  });

  it("only exposes public profiles to others, and nobody can edit someone else's", async () => {
    await as(app, owner).put("/api/v1/business/profile").send(PROFILE);
    const seen = await as(app, other).get(`/api/v1/business/profiles/${owner.userId}`);
    expect(seen.body.profile.businessName).toBe("Priya's Bakery");

    await as(app, owner).put("/api/v1/business/profile").send({ ...PROFILE, isPublic: false });
    expect((await as(app, other).get(`/api/v1/business/profiles/${owner.userId}`)).status).toBe(404);

    // "Other" writing goes to *their own* profile, never the owner's.
    await as(app, other).put("/api/v1/business/profile").send({ businessName: "Other Co" });
    expect((await as(app, owner).get("/api/v1/business/profile")).body.profile.businessName).toBe("Priya's Bakery");
  });

  it("manages quick replies, scoped to the owner and requiring a business profile", async () => {
    const early = await as(app, owner).post("/api/v1/business/quick-replies").send({ shortcut: "hours", title: "Hours", body: "Open 8–5" });
    expect(early.status).toBe(403);
    expect(early.body.error.code).toBe("business_required");

    await as(app, owner).put("/api/v1/business/profile").send(PROFILE);
    const created = await as(app, owner).post("/api/v1/business/quick-replies").send({ shortcut: "Hours", title: "Hours", body: "Open 8–5" });
    expect(created.status).toBe(201);
    expect(created.body.quickReply).toMatchObject({ shortcut: "/hours", title: "Hours" });
    const id = created.body.quickReply.id;

    expect((await as(app, owner).post("/api/v1/business/quick-replies").send({ shortcut: "/hours", title: "Dup", body: "x" })).status).toBe(409);
    expect((await as(app, owner).patch(`/api/v1/business/quick-replies/${id}`).send({ body: "Open 8–6" })).body.quickReply.body).toBe("Open 8–6");

    expect((await as(app, other).get("/api/v1/business/quick-replies")).body.quickReplies).toHaveLength(0);
    await as(app, other).put("/api/v1/business/profile").send({ businessName: "Other Co" });
    expect((await as(app, other).patch(`/api/v1/business/quick-replies/${id}`).send({ body: "hijack" })).status).toBe(404);
    expect((await as(app, other).delete(`/api/v1/business/quick-replies/${id}`)).status).toBe(404);

    expect((await as(app, owner).delete(`/api/v1/business/quick-replies/${id}`)).status).toBe(204);
    expect((await as(app, owner).get("/api/v1/business/quick-replies")).body.quickReplies).toHaveLength(0);
  });

  it("deleting the business profile removes its quick replies", async () => {
    await as(app, owner).put("/api/v1/business/profile").send(PROFILE);
    await as(app, owner).post("/api/v1/business/quick-replies").send({ shortcut: "hi", title: "Hi", body: "Hello!" });
    expect((await as(app, owner).delete("/api/v1/business/profile")).status).toBe(204);
    expect((await as(app, owner).get("/api/v1/business/quick-replies")).body.quickReplies).toHaveLength(0);
    expect((await as(app, owner).delete("/api/v1/business/profile")).status).toBe(404);
  });
});
