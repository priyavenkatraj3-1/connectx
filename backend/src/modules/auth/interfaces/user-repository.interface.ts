export interface AuthUserRecord {
  id: string;
  email: string;
  passwordHash: string;
  displayName: string;
  createdAt: Date;
}

/**
 * Storage contract the auth service depends on. Phase 1 ships an in-memory
 * implementation for local development and tests; a later phase swaps in a
 * PostgreSQL-backed implementation without touching auth.service.ts.
 */
export interface UserRepository {
  findByEmail(email: string): Promise<AuthUserRecord | null>;
  findById(id: string): Promise<AuthUserRecord | null>;
  create(user: Omit<AuthUserRecord, "id" | "createdAt">): Promise<AuthUserRecord>;
}
