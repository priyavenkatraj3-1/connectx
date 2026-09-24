import type { DatabaseClient } from "../../db/pool";
import type { OwnProfile, ProfileUpdateInput, PublicProfile } from "./users.types";

interface ProfileRow {
  id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  bio: string | null;
  status_message: string | null;
  created_at: Date;
}

const OWN_PROFILE_SELECT = `
  SELECT u.id, u.email, u.display_name, p.avatar_url, p.bio, p.status_message, u.created_at
  FROM users u
  LEFT JOIN user_profiles p ON p.user_id = u.id
  WHERE u.is_active = TRUE
`;

function toOwnProfile(row: ProfileRow): OwnProfile {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    bio: row.bio,
    statusMessage: row.status_message,
    createdAt: row.created_at,
  };
}

function toPublicProfile(row: ProfileRow): PublicProfile {
  return {
    id: row.id,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    statusMessage: row.status_message,
  };
}

export class UsersRepository {
  constructor(private readonly db: DatabaseClient) {}

  async findOwnProfile(userId: string): Promise<OwnProfile | null> {
    const result = await this.db.query<ProfileRow>(`${OWN_PROFILE_SELECT} AND u.id = $1`, [userId]);
    const row = result.rows[0];
    return row ? toOwnProfile(row) : null;
  }

  async findPublicProfile(userId: string): Promise<PublicProfile | null> {
    const result = await this.db.query<ProfileRow>(`${OWN_PROFILE_SELECT} AND u.id = $1`, [userId]);
    const row = result.rows[0];
    return row ? toPublicProfile(row) : null;
  }

  async findManyPublicProfiles(userIds: string[]): Promise<Map<string, PublicProfile>> {
    if (userIds.length === 0) return new Map();
    // Individual placeholders (not `= ANY($1)`) for portability — some
    // Postgres-compatible engines (e.g. pg-mem, used in tests) don't bind
    // array parameters the same way the real driver does.
    const placeholders = userIds.map((_, i) => `$${i + 1}`).join(", ");
    const result = await this.db.query<ProfileRow>(`${OWN_PROFILE_SELECT} AND u.id IN (${placeholders})`, userIds);
    return new Map(result.rows.map((row) => [row.id, toPublicProfile(row)]));
  }

  async updateProfile(userId: string, updates: ProfileUpdateInput): Promise<OwnProfile> {
    if (updates.displayName !== undefined) {
      await this.db.query("UPDATE users SET display_name = $1, updated_at = now() WHERE id = $2", [
        updates.displayName,
        userId,
      ]);
    }

    const profileFields: Array<[string, string | null]> = [];
    if (updates.bio !== undefined) profileFields.push(["bio", updates.bio]);
    if (updates.statusMessage !== undefined) profileFields.push(["status_message", updates.statusMessage]);
    if (updates.avatarUrl !== undefined) profileFields.push(["avatar_url", updates.avatarUrl]);

    if (profileFields.length > 0) {
      const setClauses = profileFields.map(([column], i) => `${column} = $${i + 2}`).join(", ");
      const values = profileFields.map(([, value]) => value);
      await this.db.query(
        `UPDATE user_profiles SET ${setClauses}, updated_at = now() WHERE user_id = $1`,
        [userId, ...values]
      );
    }

    const profile = await this.findOwnProfile(userId);
    if (!profile) {
      throw new Error("Profile not found after update");
    }
    return profile;
  }

  /**
   * Case-insensitive partial match on display name or email. Email is only
   * used for matching, never returned — search results expose public
   * profile fields only.
   */
  async search(query: string, excludeUserId: string, limit = 20): Promise<PublicProfile[]> {
    const pattern = `%${query}%`;
    const result = await this.db.query<ProfileRow>(
      `${OWN_PROFILE_SELECT}
         AND u.id != $1
         AND (u.display_name ILIKE $2 OR u.email ILIKE $2)
       ORDER BY u.display_name ASC
       LIMIT $3`,
      [excludeUserId, pattern, limit]
    );
    return result.rows.map(toPublicProfile);
  }
}
