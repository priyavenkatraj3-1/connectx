import type { ConversationSummary } from "../types/conversation";

/** Muted right now (an expired mute counts as not muted). */
export function isMuted(conversation: Pick<ConversationSummary, "mutedUntil">, now = Date.now()): boolean {
  return !!conversation.mutedUntil && new Date(conversation.mutedUntil).getTime() > now;
}

/** "Muted until 18:30" / "Muted until 12 Mar" / "Muted" (no end). */
export function describeMute(mutedUntil: string): string {
  const until = new Date(mutedUntil);
  if (until.getUTCFullYear() >= 9999) return "Muted";
  const sameDay = until.toDateString() === new Date().toDateString();
  return `Muted until ${sameDay ? until.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : until.toLocaleDateString([], { day: "numeric", month: "short" })}`;
}

/** Pinned chats first (keeping their relative order), then the rest, both as given (newest activity first). */
export function pinnedFirst<T extends Pick<ConversationSummary, "pinned">>(list: T[]): T[] {
  return [...list.filter((c) => c.pinned), ...list.filter((c) => !c.pinned)];
}
