import type { AIRepository } from "./ai.repository";
import { AIRateLimitError } from "./ai.errors";

export interface AIRateLimits {
  perMinute: number;
  perDay: number;
}

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Per-user limits on provider calls (the only AI operations that cost
 * money or send data out). The per-minute window is in memory (per
 * process); the per-day limit is counted from the `ai_usage` log, so it
 * survives restarts and holds across multiple processes sharing a database.
 */
export class AIRateLimiter {
  private readonly recent = new Map<string, number[]>();

  constructor(
    private readonly repository: AIRepository,
    private readonly limits: AIRateLimits,
    private readonly now: () => number = Date.now
  ) {}

  /** Throws AIRateLimitError if the user may not make another provider call right now; otherwise reserves one. */
  async acquire(userId: string): Promise<void> {
    const now = this.now();
    const windowStart = now - MINUTE_MS;
    const timestamps = (this.recent.get(userId) ?? []).filter((t) => t > windowStart);
    if (timestamps.length >= this.limits.perMinute) {
      this.recent.set(userId, timestamps);
      throw new AIRateLimitError("Too many AI requests in a short time. Please wait a minute and try again.");
    }

    const today = await this.repository.countProviderCallsSince(userId, new Date(now - DAY_MS));
    if (today >= this.limits.perDay) {
      throw new AIRateLimitError("You've reached today's AI usage limit. Please try again tomorrow.");
    }

    timestamps.push(now);
    this.recent.set(userId, timestamps);
  }
}
