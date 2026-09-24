import { randomUUID } from "crypto";
import type { AuthUserRecord, UserRepository } from "./interfaces/user-repository.interface";

/**
 * Development/testing-only implementation of UserRepository, backed by a
 * process-local Map. Data is lost on restart and is NOT shared across
 * server instances. This exists purely so Phase 1 authentication logic can
 * be exercised end-to-end before a real database is wired up — it must be
 * replaced with a persistent, database-backed repository before any real
 * user data is handled.
 */
export class InMemoryUserRepository implements UserRepository {
  private readonly usersById = new Map<string, AuthUserRecord>();
  private readonly usersByEmail = new Map<string, string>();

  async findByEmail(email: string): Promise<AuthUserRecord | null> {
    const id = this.usersByEmail.get(email);
    if (!id) return null;
    return this.usersById.get(id) ?? null;
  }

  async findById(id: string): Promise<AuthUserRecord | null> {
    return this.usersById.get(id) ?? null;
  }

  async create(user: Omit<AuthUserRecord, "id" | "createdAt">): Promise<AuthUserRecord> {
    const record: AuthUserRecord = {
      ...user,
      id: randomUUID(),
      createdAt: new Date(),
    };
    this.usersById.set(record.id, record);
    this.usersByEmail.set(record.email, record.id);
    return record;
  }
}
