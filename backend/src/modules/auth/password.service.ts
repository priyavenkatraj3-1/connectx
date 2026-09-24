import bcrypt from "bcryptjs";
import { env } from "../../config/env";

/**
 * Hashes a plain-text password with bcrypt. Never store or log the plain
 * password — only the returned hash.
 */
export async function hashPassword(plainPassword: string): Promise<string> {
  return bcrypt.hash(plainPassword, env.bcryptSaltRounds);
}

/**
 * Compares a plain-text password against a stored bcrypt hash in constant
 * time (bcrypt's compare is timing-safe by design).
 */
export async function verifyPassword(plainPassword: string, passwordHash: string): Promise<boolean> {
  return bcrypt.compare(plainPassword, passwordHash);
}
