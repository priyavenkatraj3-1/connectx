import type { DatabaseClient } from "../../db/pool";
import { AppError } from "../../middleware/errorHandler";
import type { ConversationAccessService } from "../collaboration/conversation-access";
import { EXCERPT_LENGTH, type ResolvedSource, type SourceInput, type SourceReference } from "./productivity.types";

export type ConvertedKind = "task" | "reminder" | "event";

/**
 * SQL fragments that add a `source_excerpt` column: the source message's
 * text, but only when `viewerParam` can still read it (active member who
 * joined before it was sent, message not deleted). `alias` is the item
 * table's alias; the item must have a source_message_id column.
 */
export function sourceExcerptJoin(alias: string, viewerParam: string): { select: string; joins: string } {
  return {
    select: `CASE WHEN sm.id IS NOT NULL AND scm.user_id IS NOT NULL AND sm.deleted_at IS NULL AND sm.created_at >= scm.joined_at
                  THEN sm.body ELSE NULL END AS source_excerpt`,
    joins: `LEFT JOIN messages sm ON sm.id = ${alias}.source_message_id
            LEFT JOIN conversation_members scm ON scm.conversation_id = sm.conversation_id AND scm.user_id = ${viewerParam} AND scm.left_at IS NULL`,
  };
}

export function toSourceReference(row: {
  source_conversation_id: string | null;
  source_message_id: string | null;
  source_action_id: string | null;
  source_excerpt?: string | null;
}): SourceReference {
  return {
    conversationId: row.source_conversation_id,
    messageId: row.source_message_id,
    actionId: row.source_action_id,
    messageExcerpt: row.source_excerpt ? row.source_excerpt.slice(0, EXCERPT_LENGTH) : null,
  };
}

interface ActionRow {
  id: string;
  conversation_id: string | null;
  source_message_id: string | null;
  status: string;
  converted_to: string | null;
}

/**
 * Validates and resolves where a task/reminder/event comes from. Every
 * reference is checked against the *requesting* user: a message must be
 * one they can read, a conversation one they're an active member of, and
 * an AI suggestion one of their own that hasn't been dismissed or already
 * turned into something. The original message is never modified.
 */
export class SourceResolver {
  constructor(
    private readonly db: DatabaseClient,
    private readonly access: ConversationAccessService
  ) {}

  async resolve(userId: string, input: SourceInput): Promise<ResolvedSource> {
    if (input.sourceActionId) {
      const result = await this.db.query<ActionRow>(
        "SELECT id, conversation_id, source_message_id, status, converted_to FROM ai_actions WHERE id = $1 AND user_id = $2",
        [input.sourceActionId, userId]
      );
      const action = result.rows[0];
      if (!action) throw new AppError("Suggestion not found", 404);
      if (action.status === "dismissed") throw new AppError("This suggestion was dismissed", 409);
      if (action.converted_to) throw new AppError(`This suggestion was already added as a ${action.converted_to}`, 409);
      if (action.conversation_id) await this.access.require(action.conversation_id, userId);
      return { conversationId: action.conversation_id, messageId: action.source_message_id, actionId: action.id };
    }

    if (input.sourceMessageId) {
      const conversationId = await this.access.visibleMessageConversation(input.sourceMessageId, userId);
      if (!conversationId) throw new AppError("Source message not found", 404);
      if (input.sourceConversationId && input.sourceConversationId !== conversationId) {
        throw new AppError("sourceMessageId does not belong to sourceConversationId", 400);
      }
      return { conversationId, messageId: input.sourceMessageId, actionId: null };
    }

    if (input.sourceConversationId) {
      await this.access.require(input.sourceConversationId, userId);
      return { conversationId: input.sourceConversationId, messageId: null, actionId: null };
    }

    return { conversationId: null, messageId: null, actionId: null };
  }

  /**
   * Inside the creating transaction: marks the suggestion confirmed and
   * converted. The WHERE clause makes this race-safe — two concurrent
   * conversions of one suggestion can't both succeed.
   */
  async claimAction(tx: DatabaseClient, userId: string, actionId: string, kind: ConvertedKind, itemId: string): Promise<void> {
    const result = await tx.query(
      `UPDATE ai_actions
       SET converted_to = $3, converted_id = $4, status = 'confirmed', confirmed_at = COALESCE(confirmed_at, now()), updated_at = now()
       WHERE id = $1 AND user_id = $2 AND converted_to IS NULL AND status <> 'dismissed'
       RETURNING id`,
      [actionId, userId, kind, itemId]
    );
    if (result.rowCount === 0) throw new AppError("This suggestion was already used or dismissed", 409);
  }
}
