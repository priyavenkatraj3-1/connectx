/** True for a PostgreSQL unique_violation (SQLSTATE 23505) — real `pg` and pg-mem both surface `code`. */
export function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { code?: unknown }).code === "23505";
}

export function placeholders(values: unknown[], offset = 0): string {
  return values.map((_, i) => `$${i + 1 + offset}`).join(", ");
}
