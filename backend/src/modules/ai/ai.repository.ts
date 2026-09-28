import type { DatabaseClient } from "../../db/pool";
import { generateId } from "../../utils/id";
import type {
  ActionStatus,
  ActionType,
  AIActionDTO,
  AIMemoryDTO,
  AISettings,
  Confidence,
  MemoryType,
  RiskLevel,
  VoiceResultDTO,
  VoiceStatus,
} from "./ai.types";

function placeholders(values: unknown[], offset = 0): string {
  return values.map((_, i) => `$${i + 1 + offset}`).join(", ");
}

function parseJsonArray(value: unknown): string[] {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

interface SettingsRow {
  ai_features_enabled: boolean;
  ai_memory_enabled: boolean;
  ai_chat_retrieval_enabled: boolean;
  ai_spam_shield_enabled: boolean;
  ai_voice_enabled: boolean;
  ai_preferred_language: string;
  ai_consented_at: Date | null;
}

interface MemoryRow {
  id: string;
  memory_type: MemoryType;
  content: string;
  source_conversation_id: string | null;
  source_message_id: string | null;
  created_at: Date;
  updated_at: Date;
}

interface ActionRow {
  id: string;
  user_id: string;
  conversation_id: string | null;
  source_message_id: string | null;
  type: ActionType;
  title: string;
  notes: string | null;
  due_at: Date | null;
  due_text: string | null;
  timezone: string | null;
  participants: unknown;
  confidence: Confidence | null;
  explanation: string | null;
  status: ActionStatus;
  confirmed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface VoiceRow {
  attachment_id: string;
  status: VoiceStatus;
  transcript: string | null;
  detected_language: string | null;
  summary: string | null;
  action_items: unknown;
  error_message: string | null;
  updated_at: Date;
}

/** A message row as the AI retrieval layer sees it — only fields needed to build context. */
export interface RetrievedMessageRow {
  id: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  body: string;
  createdAt: Date;
}

export interface ConversationAccessRow {
  conversationId: string;
  type: "direct" | "group";
  groupName: string | null;
}

export interface NewActionInput {
  conversationId: string;
  sourceMessageId: string;
  type: ActionType;
  title: string;
  dueAt: Date | null;
  dueText: string | null;
  timezone: string | null;
  participants: string[];
  confidence: Confidence | null;
  explanation: string | null;
}

export interface ActionUpdate {
  type?: ActionType;
  title?: string;
  notes?: string | null;
  dueAt?: Date | null;
  dueText?: string | null;
  timezone?: string | null;
}

export type UsageStatus = "success" | "error" | "timeout" | "rate_limited" | "unavailable";

function toMemory(row: MemoryRow): AIMemoryDTO {
  return {
    id: row.id,
    type: row.memory_type,
    content: row.content,
    sourceConversationId: row.source_conversation_id,
    sourceMessageId: row.source_message_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toAction(row: ActionRow): AIActionDTO {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    sourceMessageId: row.source_message_id,
    type: row.type,
    title: row.title,
    notes: row.notes,
    dueAt: row.due_at,
    dueText: row.due_text,
    timezone: row.timezone,
    participants: parseJsonArray(row.participants),
    confidence: row.confidence,
    explanation: row.explanation,
    status: row.status,
    confirmedAt: row.confirmed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toVoice(row: VoiceRow): VoiceResultDTO {
  return {
    attachmentId: row.attachment_id,
    status: row.status,
    transcript: row.transcript,
    detectedLanguage: row.detected_language,
    summary: row.summary,
    actionItems: parseJsonArray(row.action_items),
    errorMessage: row.error_message,
    updatedAt: row.updated_at,
  };
}

/**
 * Persistence for the AI layer. Every method that reads or mutates
 * user-owned AI data takes the owning `userId` and filters on it in SQL, so
 * ownership is enforced at the query level rather than only in services.
 */
export class AIRepository {
  constructor(private readonly db: DatabaseClient) {}

  // --- Settings -------------------------------------------------------------

  async getSettings(userId: string): Promise<AISettings> {
    const select = () =>
      this.db.query<SettingsRow>(
        `SELECT ai_features_enabled, ai_memory_enabled, ai_chat_retrieval_enabled, ai_spam_shield_enabled,
                ai_voice_enabled, ai_preferred_language, ai_consented_at
         FROM privacy_settings WHERE user_id = $1`,
        [userId]
      );
    let row = (await select()).rows[0];
    if (!row) {
      // Every signup creates this row; recreate defensively (all AI off) if it's missing.
      await this.db.query("INSERT INTO privacy_settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING", [userId]);
      row = (await select()).rows[0]!;
    }
    return {
      aiFeaturesEnabled: row.ai_features_enabled,
      aiMemoryEnabled: row.ai_memory_enabled,
      chatRetrievalEnabled: row.ai_chat_retrieval_enabled,
      spamShieldEnabled: row.ai_spam_shield_enabled,
      voiceEnabled: row.ai_voice_enabled,
      preferredLanguage: row.ai_preferred_language,
      consentedAt: row.ai_consented_at,
    };
  }

  async saveSettings(userId: string, settings: AISettings): Promise<void> {
    await this.db.query(
      `UPDATE privacy_settings
       SET ai_features_enabled = $2, ai_memory_enabled = $3, ai_chat_retrieval_enabled = $4,
           ai_spam_shield_enabled = $5, ai_voice_enabled = $6, ai_preferred_language = $7,
           ai_consented_at = $8, updated_at = now()
       WHERE user_id = $1`,
      [
        userId,
        settings.aiFeaturesEnabled,
        settings.aiMemoryEnabled,
        settings.chatRetrievalEnabled,
        settings.spamShieldEnabled,
        settings.voiceEnabled,
        settings.preferredLanguage,
        settings.consentedAt,
      ]
    );
  }

  // --- Conversation access & exclusions -------------------------------------

  /** Conversations among `conversationIds` where `userId` is an active member. Others are simply absent. */
  async findAccessibleConversations(userId: string, conversationIds: string[]): Promise<ConversationAccessRow[]> {
    if (conversationIds.length === 0) return [];
    const result = await this.db.query<{ id: string; type: "direct" | "group"; group_name: string | null }>(
      `SELECT c.id, c.type, g.name AS group_name
       FROM conversations c
       JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = $1 AND cm.left_at IS NULL
       LEFT JOIN groups g ON g.conversation_id = c.id
       WHERE c.id IN (${placeholders(conversationIds, 1)})`,
      [userId, ...conversationIds]
    );
    return result.rows.map((row) => ({ conversationId: row.id, type: row.type, groupName: row.group_name }));
  }

  /** Display name of the other participant(s) in each direct conversation, for context labels. */
  async findDirectPartnerNames(userId: string, conversationIds: string[]): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    if (conversationIds.length === 0) return names;
    const result = await this.db.query<{ conversation_id: string; display_name: string }>(
      `SELECT cm.conversation_id, u.display_name
       FROM conversation_members cm JOIN users u ON u.id = cm.user_id
       WHERE cm.user_id != $1 AND cm.conversation_id IN (${placeholders(conversationIds, 1)})`,
      [userId, ...conversationIds]
    );
    for (const row of result.rows) names.set(row.conversation_id, row.display_name);
    return names;
  }

  async listExclusions(userId: string): Promise<string[]> {
    const result = await this.db.query<{ conversation_id: string }>(
      "SELECT conversation_id FROM ai_conversation_exclusions WHERE user_id = $1 ORDER BY created_at",
      [userId]
    );
    return result.rows.map((row) => row.conversation_id);
  }

  async addExclusion(userId: string, conversationId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO ai_conversation_exclusions (user_id, conversation_id) VALUES ($1, $2)
       ON CONFLICT (user_id, conversation_id) DO NOTHING`,
      [userId, conversationId]
    );
  }

  async removeExclusion(userId: string, conversationId: string): Promise<void> {
    await this.db.query("DELETE FROM ai_conversation_exclusions WHERE user_id = $1 AND conversation_id = $2", [
      userId,
      conversationId,
    ]);
  }

  // --- Message retrieval (authorization is part of every query) -------------

  /**
   * Non-deleted text messages in `conversationIds` that `userId` may read:
   * they must be an active member and the message must be from on/after
   * their join time — the same visibility rule as normal message history.
   * Optional `terms` filter (any term, case-insensitive substring). Newest first.
   */
  async findVisibleMessages(
    userId: string,
    conversationIds: string[],
    options: { terms?: string[]; limit: number; messageIds?: string[] }
  ): Promise<RetrievedMessageRow[]> {
    if (conversationIds.length === 0) return [];
    const params: unknown[] = [userId, ...conversationIds];
    let extra = "";
    if (options.terms && options.terms.length > 0) {
      const clauses = options.terms.map((term) => {
        params.push(`%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
        return `LOWER(m.body) LIKE $${params.length}`;
      });
      extra += ` AND (${clauses.join(" OR ")})`;
    }
    if (options.messageIds) {
      if (options.messageIds.length === 0) return [];
      extra += ` AND m.id IN (${placeholders(options.messageIds, params.length)})`;
      params.push(...options.messageIds);
    }
    params.push(options.limit);

    const result = await this.db.query<{
      id: string;
      conversation_id: string;
      sender_id: string;
      sender_name: string;
      body: string;
      created_at: Date;
    }>(
      `SELECT m.id, m.conversation_id, m.sender_id, u.display_name AS sender_name, m.body, m.created_at
       FROM messages m
       JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $1 AND cm.left_at IS NULL
       JOIN users u ON u.id = m.sender_id
       WHERE m.conversation_id IN (${placeholders(conversationIds, 1)})
         AND m.deleted_at IS NULL AND m.body IS NOT NULL AND m.created_at >= cm.joined_at
         ${extra}
       ORDER BY m.created_at DESC
       LIMIT $${params.length}`,
      params
    );
    return result.rows.map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      senderId: row.sender_id,
      senderName: row.sender_name,
      body: row.body,
      createdAt: row.created_at,
    }));
  }

  // --- Memory ---------------------------------------------------------------

  async listMemories(userId: string, limit = 500): Promise<AIMemoryDTO[]> {
    const result = await this.db.query<MemoryRow>(
      `SELECT id, memory_type, content, source_conversation_id, source_message_id, created_at, updated_at
       FROM ai_memories WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [userId, limit]
    );
    return result.rows.map(toMemory);
  }

  async countMemories(userId: string): Promise<number> {
    const result = await this.db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM ai_memories WHERE user_id = $1", [userId]);
    return Number(result.rows[0]?.n ?? 0);
  }

  async createMemory(input: {
    userId: string;
    type: MemoryType;
    content: string;
    sourceConversationId: string | null;
    sourceMessageId: string | null;
  }): Promise<AIMemoryDTO> {
    const id = generateId();
    await this.db.query(
      `INSERT INTO ai_memories (id, user_id, memory_type, content, source_conversation_id, source_message_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, input.userId, input.type, input.content, input.sourceConversationId, input.sourceMessageId]
    );
    const result = await this.db.query<MemoryRow>(
      `SELECT id, memory_type, content, source_conversation_id, source_message_id, created_at, updated_at
       FROM ai_memories WHERE id = $1`,
      [id]
    );
    return toMemory(result.rows[0]!);
  }

  /** Deletes only if the memory belongs to `userId`. Returns whether a row was deleted. */
  async deleteMemory(userId: string, memoryId: string): Promise<boolean> {
    const result = await this.db.query("DELETE FROM ai_memories WHERE id = $1 AND user_id = $2", [memoryId, userId]);
    return result.rowCount > 0;
  }

  async clearMemories(userId: string): Promise<number> {
    const result = await this.db.query("DELETE FROM ai_memories WHERE user_id = $1", [userId]);
    return result.rowCount;
  }

  // --- Actions --------------------------------------------------------------

  async insertSuggestedActions(userId: string, actions: NewActionInput[]): Promise<AIActionDTO[]> {
    const ids: string[] = [];
    await this.db.withTransaction(async (tx) => {
      for (const action of actions) {
        const id = generateId();
        ids.push(id);
        await tx.query(
          `INSERT INTO ai_actions (id, user_id, conversation_id, source_message_id, type, title, due_at, due_text,
                                   timezone, participants, confidence, explanation, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'suggested')`,
          [
            id,
            userId,
            action.conversationId,
            action.sourceMessageId,
            action.type,
            action.title,
            action.dueAt,
            action.dueText,
            action.timezone,
            JSON.stringify(action.participants),
            action.confidence,
            action.explanation,
          ]
        );
      }
    });
    if (ids.length === 0) return [];
    const result = await this.db.query<ActionRow>(
      `SELECT * FROM ai_actions WHERE id IN (${placeholders(ids)}) ORDER BY created_at`,
      ids
    );
    return result.rows.map(toAction);
  }

  async listActions(userId: string, filters: { status?: ActionStatus; conversationId?: string }): Promise<AIActionDTO[]> {
    const params: unknown[] = [userId];
    let where = "user_id = $1";
    if (filters.status) {
      params.push(filters.status);
      where += ` AND status = $${params.length}`;
    }
    if (filters.conversationId) {
      params.push(filters.conversationId);
      where += ` AND conversation_id = $${params.length}`;
    }
    const result = await this.db.query<ActionRow>(
      `SELECT * FROM ai_actions WHERE ${where} ORDER BY created_at DESC LIMIT 200`,
      params
    );
    return result.rows.map(toAction);
  }

  async findAction(userId: string, actionId: string): Promise<AIActionDTO | null> {
    const result = await this.db.query<ActionRow>("SELECT * FROM ai_actions WHERE id = $1 AND user_id = $2", [actionId, userId]);
    const row = result.rows[0];
    return row ? toAction(row) : null;
  }

  async updateAction(userId: string, actionId: string, update: ActionUpdate): Promise<AIActionDTO | null> {
    const sets: string[] = [];
    const params: unknown[] = [actionId, userId];
    const columns: Array<[keyof ActionUpdate, string]> = [
      ["type", "type"],
      ["title", "title"],
      ["notes", "notes"],
      ["dueAt", "due_at"],
      ["dueText", "due_text"],
      ["timezone", "timezone"],
    ];
    for (const [key, column] of columns) {
      if (update[key] !== undefined) {
        params.push(update[key]);
        sets.push(`${column} = $${params.length}`);
      }
    }
    if (sets.length > 0) {
      await this.db.query(
        `UPDATE ai_actions SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 AND user_id = $2`,
        params
      );
    }
    return this.findAction(userId, actionId);
  }

  async setActionStatus(userId: string, actionId: string, status: ActionStatus): Promise<AIActionDTO | null> {
    await this.db.query(
      `UPDATE ai_actions
       SET status = $3, confirmed_at = ${status === "confirmed" ? "now()" : "NULL"}, updated_at = now()
       WHERE id = $1 AND user_id = $2`,
      [actionId, userId, status]
    );
    return this.findAction(userId, actionId);
  }

  // --- Translation cache ----------------------------------------------------

  async findTranslation(
    messageId: string,
    targetLanguage: string
  ): Promise<{ sourceHash: string; translatedText: string; detectedSourceLanguage: string | null } | null> {
    const result = await this.db.query<{ source_hash: string; translated_text: string; detected_source_language: string | null }>(
      "SELECT source_hash, translated_text, detected_source_language FROM ai_translations WHERE message_id = $1 AND target_language = $2",
      [messageId, targetLanguage]
    );
    const row = result.rows[0];
    return row
      ? { sourceHash: row.source_hash.trim(), translatedText: row.translated_text, detectedSourceLanguage: row.detected_source_language }
      : null;
  }

  async saveTranslation(input: {
    messageId: string;
    targetLanguage: string;
    sourceHash: string;
    translatedText: string;
    detectedSourceLanguage: string | null;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO ai_translations (message_id, target_language, source_hash, translated_text, detected_source_language)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (message_id, target_language) DO UPDATE
       SET source_hash = $3, translated_text = $4, detected_source_language = $5, created_at = now()`,
      [input.messageId, input.targetLanguage, input.sourceHash, input.translatedText, input.detectedSourceLanguage]
    );
  }

  // --- Scam shield feedback -------------------------------------------------

  async saveMessageFlag(userId: string, messageId: string, action: "dismissed" | "reported", riskLevel: RiskLevel | null): Promise<void> {
    await this.db.query(
      `INSERT INTO ai_message_flags (user_id, message_id, action, risk_level) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, message_id) DO UPDATE SET action = $3, risk_level = $4, created_at = now()`,
      [userId, messageId, action, riskLevel]
    );
  }

  async findFlaggedMessageIds(userId: string, messageIds: string[]): Promise<Set<string>> {
    if (messageIds.length === 0) return new Set();
    const result = await this.db.query<{ message_id: string }>(
      `SELECT message_id FROM ai_message_flags WHERE user_id = $1 AND message_id IN (${placeholders(messageIds, 1)})`,
      [userId, ...messageIds]
    );
    return new Set(result.rows.map((row) => row.message_id));
  }

  // --- Voice ----------------------------------------------------------------

  async findVoiceResult(userId: string, attachmentId: string): Promise<VoiceResultDTO | null> {
    const result = await this.db.query<VoiceRow>(
      `SELECT attachment_id, status, transcript, detected_language, summary, action_items, error_message, updated_at
       FROM ai_voice_results WHERE user_id = $1 AND attachment_id = $2`,
      [userId, attachmentId]
    );
    const row = result.rows[0];
    return row ? toVoice(row) : null;
  }

  async saveVoiceResult(
    userId: string,
    attachmentId: string,
    state: {
      status: VoiceStatus;
      transcript?: string | null;
      detectedLanguage?: string | null;
      summary?: string | null;
      actionItems?: string[];
      errorMessage?: string | null;
    }
  ): Promise<VoiceResultDTO> {
    const existing = await this.findVoiceResult(userId, attachmentId);
    const merged = {
      transcript: state.transcript !== undefined ? state.transcript : (existing?.transcript ?? null),
      detectedLanguage: state.detectedLanguage !== undefined ? state.detectedLanguage : (existing?.detectedLanguage ?? null),
      summary: state.summary !== undefined ? state.summary : (existing?.summary ?? null),
      actionItems: state.actionItems ?? existing?.actionItems ?? [],
      errorMessage: state.errorMessage !== undefined ? state.errorMessage : null,
    };
    if (existing) {
      await this.db.query(
        `UPDATE ai_voice_results
         SET status = $3, transcript = $4, detected_language = $5, summary = $6, action_items = $7,
             error_message = $8, updated_at = now()
         WHERE user_id = $1 AND attachment_id = $2`,
        [
          userId,
          attachmentId,
          state.status,
          merged.transcript,
          merged.detectedLanguage,
          merged.summary,
          JSON.stringify(merged.actionItems),
          merged.errorMessage,
        ]
      );
    } else {
      await this.db.query(
        `INSERT INTO ai_voice_results (id, user_id, attachment_id, status, transcript, detected_language, summary, action_items, error_message)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          generateId(),
          userId,
          attachmentId,
          state.status,
          merged.transcript,
          merged.detectedLanguage,
          merged.summary,
          JSON.stringify(merged.actionItems),
          merged.errorMessage,
        ]
      );
    }
    return (await this.findVoiceResult(userId, attachmentId))!;
  }

  // --- Usage ----------------------------------------------------------------

  /** Metadata only — callers must never pass prompt or output text here. */
  async recordUsage(entry: {
    id: string;
    userId: string;
    feature: string;
    provider: string;
    model: string | null;
    status: UsageStatus;
    errorCode: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
    latencyMs: number | null;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO ai_usage (id, user_id, feature, provider, model, status, error_code, input_tokens, output_tokens, latency_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        entry.id,
        entry.userId,
        entry.feature,
        entry.provider,
        entry.model,
        entry.status,
        entry.errorCode,
        entry.inputTokens,
        entry.outputTokens,
        entry.latencyMs,
      ]
    );
  }

  /** Provider calls attempted since `since` (successful or failed) — the basis of the daily limit. */
  async countProviderCallsSince(userId: string, since: Date): Promise<number> {
    const result = await this.db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM ai_usage
       WHERE user_id = $1 AND created_at > $2 AND status IN ('success', 'error', 'timeout')`,
      [userId, since]
    );
    return Number(result.rows[0]?.n ?? 0);
  }
}
