import { randomUUID } from "crypto";

/** Generates a new record ID. Centralized so storage layers never call `randomUUID` directly. */
export function generateId(): string {
  return randomUUID();
}
