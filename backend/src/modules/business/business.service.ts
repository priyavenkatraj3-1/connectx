import type { DatabaseClient } from "../../db/pool";
import { isUniqueViolation } from "../../db/errors";
import { AppError } from "../../middleware/errorHandler";
import type { RealtimeGateway } from "../../realtime/gateway.interface";
import { generateId } from "../../utils/id";

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export type BusinessHours = Partial<Record<Weekday, Array<{ open: string; close: string }>>>;

/**
 * "unverified" is the only status ConnectX ever assigns. There is no
 * verification process yet, so nothing can make a profile "verified";
 * the column exists so one can be added without a schema change.
 */
export type VerificationStatus = "unverified" | "pending" | "verified";

export interface BusinessProfileDTO {
  userId: string;
  businessName: string;
  description: string | null;
  category: string | null;
  website: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  address: string | null;
  businessHours: BusinessHours;
  verificationStatus: VerificationStatus;
  isPublic: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface BusinessProfileInput {
  businessName: string;
  description?: string | null;
  category?: string | null;
  website?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  address?: string | null;
  businessHours?: BusinessHours;
  isPublic?: boolean;
}

export interface QuickReplyDTO {
  id: string;
  shortcut: string;
  title: string;
  body: string;
  createdAt: Date;
  updatedAt: Date;
}

interface ProfileRow {
  user_id: string;
  business_name: string;
  description: string | null;
  category: string | null;
  website: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  address: string | null;
  business_hours: unknown;
  verification_status: VerificationStatus;
  is_public: boolean;
  created_at: Date;
  updated_at: Date;
}

interface QuickReplyRow {
  id: string;
  shortcut: string;
  title: string;
  body: string;
  created_at: Date;
  updated_at: Date;
}

function toProfile(row: ProfileRow): BusinessProfileDTO {
  const hours = typeof row.business_hours === "string" ? (JSON.parse(row.business_hours) as unknown) : row.business_hours;
  return {
    userId: row.user_id,
    businessName: row.business_name,
    description: row.description,
    category: row.category,
    website: row.website,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    address: row.address,
    businessHours: (hours && typeof hours === "object" ? hours : {}) as BusinessHours,
    verificationStatus: row.verification_status,
    isPublic: row.is_public,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toQuickReply(row: QuickReplyRow): QuickReplyDTO {
  return { id: row.id, shortcut: row.shortcut, title: row.title, body: row.body, createdAt: row.created_at, updatedAt: row.updated_at };
}

export const MAX_QUICK_REPLIES = 100;

/**
 * Business profile foundation (Phase 6). A business profile is a separate
 * record next to the personal profile (user_profiles) — enabling one never
 * changes the person's display name, avatar or bio. Every write is scoped
 * to the authenticated user's own row; there is no way to target another
 * account's profile or quick replies.
 */
export class BusinessService {
  constructor(
    private readonly db: DatabaseClient,
    private readonly gateway: RealtimeGateway
  ) {}

  async getOwn(userId: string): Promise<BusinessProfileDTO | null> {
    const result = await this.db.query<ProfileRow>("SELECT * FROM business_profiles WHERE user_id = $1", [userId]);
    const row = result.rows[0];
    return row ? toProfile(row) : null;
  }

  /** Another user's business profile, if they made it public. */
  async getPublic(userId: string): Promise<BusinessProfileDTO> {
    const result = await this.db.query<ProfileRow>(
      "SELECT b.* FROM business_profiles b JOIN users u ON u.id = b.user_id WHERE b.user_id = $1 AND b.is_public = TRUE AND u.is_active = TRUE",
      [userId]
    );
    const row = result.rows[0];
    if (!row) throw new AppError("Business profile not found", 404);
    return toProfile(row);
  }

  async upsert(userId: string, input: BusinessProfileInput): Promise<BusinessProfileDTO> {
    const values = [
      input.businessName,
      input.description ?? null,
      input.category ?? null,
      input.website ?? null,
      input.contactEmail ?? null,
      input.contactPhone ?? null,
      input.address ?? null,
      JSON.stringify(input.businessHours ?? {}),
      input.isPublic ?? true,
    ];
    const existing = await this.getOwn(userId);
    if (existing) {
      // verification_status is deliberately never part of an update.
      await this.db.query(
        `UPDATE business_profiles SET business_name = $2, description = $3, category = $4, website = $5, contact_email = $6,
                contact_phone = $7, address = $8, business_hours = $9, is_public = $10, updated_at = now()
         WHERE user_id = $1`,
        [userId, ...values]
      );
    } else {
      await this.db.query(
        `INSERT INTO business_profiles (user_id, business_name, description, category, website, contact_email, contact_phone,
                                        address, business_hours, is_public)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [userId, ...values]
      );
    }
    const profile = (await this.getOwn(userId))!;
    this.gateway.sendToUser(userId, { type: "business:updated", profile });
    return profile;
  }

  /** Removes the business profile and its quick replies. The personal profile is untouched. */
  async remove(userId: string): Promise<void> {
    await this.db.withTransaction(async (tx) => {
      await tx.query("DELETE FROM quick_replies WHERE user_id = $1", [userId]);
      const result = await tx.query("DELETE FROM business_profiles WHERE user_id = $1 RETURNING user_id", [userId]);
      if (result.rowCount === 0) throw new AppError("You don't have a business profile", 404);
    });
    this.gateway.sendToUser(userId, { type: "business:updated", profile: null });
    this.gateway.sendToUser(userId, { type: "quick_replies:updated", quickReplies: [] });
  }

  // --- Quick replies ----------------------------------------------------------

  async listQuickReplies(userId: string): Promise<QuickReplyDTO[]> {
    const result = await this.db.query<QuickReplyRow>("SELECT * FROM quick_replies WHERE user_id = $1 ORDER BY shortcut ASC", [userId]);
    return result.rows.map(toQuickReply);
  }

  private async requireBusiness(userId: string): Promise<void> {
    if (!(await this.getOwn(userId))) throw new AppError("Create a business profile before adding quick replies", 403, true, "business_required");
  }

  async createQuickReply(userId: string, input: { shortcut: string; title: string; body: string }): Promise<QuickReplyDTO> {
    await this.requireBusiness(userId);
    const count = await this.db.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM quick_replies WHERE user_id = $1", [userId]);
    if (Number(count.rows[0]?.count ?? "0") >= MAX_QUICK_REPLIES) throw new AppError(`At most ${MAX_QUICK_REPLIES} quick replies`, 409);
    const id = generateId();
    try {
      await this.db.query("INSERT INTO quick_replies (id, user_id, shortcut, title, body) VALUES ($1, $2, $3, $4, $5)", [
        id,
        userId,
        input.shortcut,
        input.title,
        input.body,
      ]);
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError(`You already have a quick reply with the shortcut "${input.shortcut}"`, 409);
      throw err;
    }
    return this.publishQuickReply(userId, id);
  }

  async updateQuickReply(userId: string, id: string, input: { shortcut?: string; title?: string; body?: string }): Promise<QuickReplyDTO> {
    await this.requireBusiness(userId);
    const sets: string[] = [];
    const params: unknown[] = [id, userId];
    for (const key of ["shortcut", "title", "body"] as const) {
      if (input[key] !== undefined) {
        params.push(input[key]);
        sets.push(`${key} = $${params.length}`);
      }
    }
    try {
      const result = await this.db.query(
        `UPDATE quick_replies SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 AND user_id = $2 RETURNING id`,
        params
      );
      if (result.rowCount === 0) throw new AppError("Quick reply not found", 404);
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError(`You already have a quick reply with the shortcut "${input.shortcut}"`, 409);
      throw err;
    }
    return this.publishQuickReply(userId, id);
  }

  async deleteQuickReply(userId: string, id: string): Promise<void> {
    const result = await this.db.query("DELETE FROM quick_replies WHERE id = $1 AND user_id = $2 RETURNING id", [id, userId]);
    if (result.rowCount === 0) throw new AppError("Quick reply not found", 404);
    this.gateway.sendToUser(userId, { type: "quick_replies:updated", quickReplies: await this.listQuickReplies(userId) });
  }

  private async publishQuickReply(userId: string, id: string): Promise<QuickReplyDTO> {
    const quickReplies = await this.listQuickReplies(userId);
    this.gateway.sendToUser(userId, { type: "quick_replies:updated", quickReplies });
    return quickReplies.find((reply) => reply.id === id)!;
  }
}
