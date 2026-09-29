import type { DatabaseClient } from "../../db/pool";
import { generateId } from "../../utils/id";
import type { AuthUserRecord, UserRepository } from "./interfaces/user-repository.interface";

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  display_name: string;
  created_at: Date;
}

function toRecord(row: UserRow): AuthUserRecord {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    displayName: row.display_name,
    createdAt: row.created_at,
  };
}

/**
 * PostgreSQL-backed implementation of UserRepository. This is what makes
 * authentication actually persistent (Phase 2) — no data is lost on
 * process restart, and multiple backend instances share the same users.
 */
export class PostgresUserRepository implements UserRepository {
  constructor(private readonly db: DatabaseClient) {}

  async findByEmail(email: string): Promise<AuthUserRecord | null> {
    const result = await this.db.query<UserRow>(
      "SELECT id, email, password_hash, display_name, created_at FROM users WHERE email = $1",
      [email]
    );
    const row = result.rows[0];
    return row ? toRecord(row) : null;
  }

  async findById(id: string): Promise<AuthUserRecord | null> {
    const result = await this.db.query<UserRow>(
      "SELECT id, email, password_hash, display_name, created_at FROM users WHERE id = $1",
      [id]
    );
    const row = result.rows[0];
    return row ? toRecord(row) : null;
  }

  async create(user: Omit<AuthUserRecord, "id" | "createdAt">): Promise<AuthUserRecord> {
    const id = generateId();
    // One transaction: an account is never left without its profile/privacy rows.
    return this.db.withTransaction(async (tx) => {
      const result = await tx.query<UserRow>(
        `INSERT INTO users (id, email, password_hash, display_name)
         VALUES ($1, $2, $3, $4)
         RETURNING id, email, password_hash, display_name, created_at`,
        [id, user.email, user.passwordHash, user.displayName]
      );
      const row = result.rows[0];
      if (!row) {
        throw new Error("Failed to create user");
      }

      // A fresh account gets an empty profile row and default privacy
      // settings up front so every other Phase 2 query (profile lookups,
      // AI consent checks) can rely on the row existing.
      await tx.query("INSERT INTO user_profiles (user_id) VALUES ($1)", [id]);
      await tx.query("INSERT INTO privacy_settings (user_id) VALUES ($1)", [id]);

      return toRecord(row);
    });
  }
}
