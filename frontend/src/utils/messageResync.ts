import type { MessageDTO } from "../types/message";

export interface LatestPage {
  items: MessageDTO[];
  hasMore: boolean;
}

/**
 * Merges a freshly fetched latest page of a conversation (oldest → newest)
 * into the messages currently shown, after events may have been missed.
 *
 * - The page is the source of truth for its time range (new messages, edits,
 *   receipts, deletions).
 * - Loaded history older than the page is kept only when it connects to the
 *   page. If the page doesn't reach back to the newest message shown, more
 *   arrived than one page holds: keeping the old messages would leave a silent
 *   gap, so the list is replaced by the page and `hasMore` is set from it.
 */
export function reconcileLatestPage(shown: MessageDTO[], page: LatestPage): { messages: MessageDTO[]; hasMore: boolean | null } {
  const oldestInPage = page.items[0];
  // The page holds the whole conversation (or it's empty now): it replaces everything.
  if (!page.hasMore || !oldestInPage) return { messages: page.items, hasMore: page.hasMore };

  const newestShown = shown[shown.length - 1];
  const pageIds = new Set(page.items.map((m) => m.id));
  const connects = !newestShown || pageIds.has(newestShown.id) || oldestInPage.createdAt <= newestShown.createdAt;
  if (!connects) return { messages: page.items, hasMore: true };

  const olderHistory = shown.filter((m) => !pageIds.has(m.id) && m.createdAt < oldestInPage.createdAt);
  // `null`: keep the current hasMore — the older history shown is unchanged.
  return { messages: [...olderHistory, ...page.items], hasMore: null };
}
