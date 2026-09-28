import { AppError } from "../../../middleware/errorHandler";
import type { AIRepository, RetrievedMessageRow } from "../ai.repository";
import type { AISourceReference } from "../ai.types";

export interface AuthorizedConversation {
  conversationId: string;
  type: "direct" | "group";
  title: string;
}

/** One message as placed into an AI prompt, with a short, prompt-local reference id ("M1"). */
export interface ContextMessage {
  ref: string;
  messageId: string;
  conversationId: string;
  conversationTitle: string;
  senderId: string;
  senderName: string;
  createdAt: Date;
  text: string;
}

export interface AIContextOptions {
  /** Total characters of message text allowed in one prompt. */
  maxContextChars: number;
  /** Per-message cap; longer messages are truncated with an ellipsis. */
  maxMessageChars?: number;
}

const STOPWORDS = new Set(
  (
    "the and for are but not you your yours with this that these those was were what when where which who whom why how " +
    "did does doing done have has had about into from they them their there then than our ours out over under again " +
    "any all can could would should will just also been being some such only own same very more most other its it's " +
    "let lets say said tell told me my mine we us i a an of to in on at by is be do or as if so up no yes please " +
    "summarize summary conversation conversations chat chats message messages discussed discuss mentioned last"
  ).split(/\s+/)
);

/** Lowercased keywords from a question, used for SQL candidate filtering. Unicode-aware; at most 8. */
export function extractSearchTerms(question: string): string[] {
  // \p{M} keeps combining marks (e.g. Devanagari vowel signs) inside words.
  const words = question.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}'-]*/gu) ?? [];
  const terms: string[] = [];
  for (const word of words) {
    const clean = word.replace(/^['-]+|['-]+$/g, "");
    if (clean.length < 3 || STOPWORDS.has(clean) || terms.includes(clean)) continue;
    terms.push(clean);
    if (terms.length === 8) break;
  }
  return terms;
}

function scoreMessage(body: string, terms: string[]): number {
  const text = body.toLowerCase();
  let distinct = 0;
  let total = 0;
  for (const term of terms) {
    let index = text.indexOf(term);
    if (index === -1) continue;
    distinct += 1;
    while (index !== -1 && total < 50) {
      total += 1;
      index = text.indexOf(term, index + term.length);
    }
  }
  return distinct * 3 + Math.min(total, 10);
}

/**
 * Reusable retrieval layer for every AI feature that reads chats.
 *
 * - `authorize` is the gate: every requested conversation must be one the
 *   user is an active member of (otherwise 403 — nothing is silently
 *   dropped or partially answered) and not excluded from AI by them.
 * - Retrieval SQL re-applies membership and join-time visibility, so even a
 *   caller bug can't pull messages the user couldn't read in the app.
 * - Context is bounded by message count and total characters, preferring
 *   relevant matches, then recent messages.
 */
export class AIContextService {
  private readonly maxMessageChars: number;

  constructor(
    private readonly repository: AIRepository,
    private readonly options: AIContextOptions
  ) {
    this.maxMessageChars = options.maxMessageChars ?? 800;
  }

  async authorize(userId: string, conversationIds: string[]): Promise<AuthorizedConversation[]> {
    const unique = [...new Set(conversationIds)];
    const accessible = await this.repository.findAccessibleConversations(userId, unique);
    if (accessible.length !== unique.length) {
      throw new AppError("You do not have access to one or more of the selected conversations", 403);
    }
    const excluded = new Set(await this.repository.listExclusions(userId));
    if (unique.some((id) => excluded.has(id))) {
      throw new AppError(
        "One or more of the selected conversations is excluded from AI in your settings",
        400,
        true,
        "ai_conversation_excluded"
      );
    }

    const partnerNames = await this.repository.findDirectPartnerNames(
      userId,
      accessible.filter((c) => c.type === "direct").map((c) => c.conversationId)
    );
    return accessible.map((conversation) => ({
      conversationId: conversation.conversationId,
      type: conversation.type,
      title:
        conversation.type === "group"
          ? (conversation.groupName ?? "Group chat")
          : `Chat with ${partnerNames.get(conversation.conversationId) ?? "unknown user"}`,
    }));
  }

  /** Relevance-ranked keyword matches plus a slice of the most recent messages, for question answering. */
  async retrieveRelevant(
    userId: string,
    conversations: AuthorizedConversation[],
    question: string,
    limits: { maxMessages?: number; recentMessages?: number } = {}
  ): Promise<ContextMessage[]> {
    const ids = conversations.map((c) => c.conversationId);
    const maxMessages = limits.maxMessages ?? 60;
    const terms = extractSearchTerms(question);

    const [candidates, recent] = await Promise.all([
      terms.length > 0 ? this.repository.findVisibleMessages(userId, ids, { terms, limit: 300 }) : Promise.resolve([]),
      this.repository.findVisibleMessages(userId, ids, { limit: limits.recentMessages ?? 20 }),
    ]);

    const ranked = candidates
      .map((row, index) => ({ row, score: scoreMessage(row.body, terms) - index * 0.001 }))
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.row);

    const seen = new Set<string>();
    const prioritized: RetrievedMessageRow[] = [];
    for (const row of [...ranked.slice(0, maxMessages), ...recent]) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      prioritized.push(row);
    }
    return this.build(prioritized.slice(0, maxMessages + (limits.recentMessages ?? 20)), conversations);
  }

  /** The most recent visible messages (for summaries / extraction), newest kept first under the budget. */
  async retrieveRecent(userId: string, conversations: AuthorizedConversation[], maxMessages = 150): Promise<ContextMessage[]> {
    const rows = await this.repository.findVisibleMessages(
      userId,
      conversations.map((c) => c.conversationId),
      { limit: maxMessages }
    );
    return this.build(rows, conversations);
  }

  /** Specific messages chosen by the user; every id must be visible to them in the given conversation. */
  async retrieveByIds(userId: string, conversation: AuthorizedConversation, messageIds: string[]): Promise<ContextMessage[]> {
    const unique = [...new Set(messageIds)];
    const rows = await this.repository.findVisibleMessages(userId, [conversation.conversationId], {
      messageIds: unique,
      limit: unique.length,
    });
    if (rows.length !== unique.length) {
      throw new AppError("One or more of the selected messages wasn't found in this conversation", 404);
    }
    return this.build(rows, [conversation]);
  }

  /** Maps model-returned refs back to real messages; unknown refs are dropped, never trusted. */
  resolveRefs(refs: string[], context: ContextMessage[]): AISourceReference[] {
    const byRef = new Map(context.map((message) => [message.ref, message]));
    const seen = new Set<string>();
    const sources: AISourceReference[] = [];
    for (const ref of refs) {
      const message = byRef.get(ref.trim());
      if (!message || seen.has(message.ref)) continue;
      seen.add(message.ref);
      sources.push({
        ref: message.ref,
        messageId: message.messageId,
        conversationId: message.conversationId,
        conversationTitle: message.conversationTitle,
        senderName: message.senderName,
        createdAt: message.createdAt,
        excerpt: message.text.length > 300 ? `${message.text.slice(0, 299)}…` : message.text,
      });
    }
    return sources;
  }

  /**
   * Keeps rows in priority order until the character budget is spent, then
   * orders the survivors chronologically and assigns refs M1..Mn.
   */
  private build(rows: RetrievedMessageRow[], conversations: AuthorizedConversation[]): ContextMessage[] {
    const titles = new Map(conversations.map((c) => [c.conversationId, c.title]));
    let budget = this.options.maxContextChars;
    const kept: Array<RetrievedMessageRow & { text: string }> = [];
    for (const row of rows) {
      const text = row.body.length > this.maxMessageChars ? `${row.body.slice(0, this.maxMessageChars - 1)}…` : row.body;
      const cost = text.length + row.senderName.length + 64;
      if (cost > budget) break;
      budget -= cost;
      kept.push({ ...row, text });
    }
    kept.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    return kept.map((row, index) => ({
      ref: `M${index + 1}`,
      messageId: row.id,
      conversationId: row.conversationId,
      conversationTitle: titles.get(row.conversationId) ?? "Chat",
      senderId: row.senderId,
      senderName: row.senderName,
      createdAt: new Date(row.createdAt),
      text: row.text,
    }));
  }
}
