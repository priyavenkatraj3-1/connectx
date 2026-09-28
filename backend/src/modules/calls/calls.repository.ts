import type { DatabaseClient } from "../../db/pool";
import { generateId } from "../../utils/id";
import type {
  CallDTO,
  CallEndReason,
  CallEventType,
  CallMedia,
  CallParticipantDTO,
  CallParticipantRole,
  CallParticipantState,
  CallScope,
  CallState,
} from "./calls.types";

interface SessionRow {
  id: string;
  conversation_id: string;
  initiator_id: string;
  scope: CallScope;
  media: CallMedia;
  state: CallState;
  end_reason: CallEndReason | null;
  created_at: Date;
  answered_at: Date | null;
  connected_at: Date | null;
  ended_at: Date | null;
  duration_seconds: number | null;
}

interface ParticipantRow {
  call_id: string;
  user_id: string;
  display_name: string;
  avatar_url: string | null;
  role: CallParticipantRole;
  state: CallParticipantState;
  invited_at: Date;
  joined_at: Date | null;
  left_at: Date | null;
}

const SESSION_COLUMNS = `id, conversation_id, initiator_id, scope, media, state, end_reason, created_at, answered_at,
  connected_at, ended_at, duration_seconds`;

const LIVE_STATES_SQL = "('ringing', 'accepted', 'connecting', 'connected')";

function placeholders(values: unknown[], offset = 0): string {
  return values.map((_, i) => `$${i + 1 + offset}`).join(", ");
}

function toParticipant(row: ParticipantRow): CallParticipantDTO {
  return {
    userId: row.user_id,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    role: row.role,
    state: row.state,
    joinedAt: row.joined_at,
    leftAt: row.left_at,
    audioEnabled: null,
    videoEnabled: null,
  };
}

function toCall(row: SessionRow, participants: CallParticipantDTO[]): CallDTO {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    scope: row.scope,
    media: row.media,
    state: row.state,
    endReason: row.end_reason,
    initiatorId: row.initiator_id,
    createdAt: row.created_at,
    answeredAt: row.answered_at,
    connectedAt: row.connected_at,
    endedAt: row.ended_at,
    durationSeconds: row.duration_seconds === null ? null : Number(row.duration_seconds),
    participants,
  };
}

export class LiveCallExistsError extends Error {
  constructor(public readonly callId: string | null) {
    super("A call is already in progress in this conversation");
  }
}

export interface SessionPatch {
  state: CallState;
  answeredAt?: Date;
  connectedAt?: Date;
  endedAt?: Date;
  endReason?: CallEndReason;
  durationSeconds?: number | null;
}

/**
 * Persistence for call sessions. Stores call *metadata* only — who, when,
 * which conversation, how it ended. No SDP, ICE candidates, audio or video
 * is ever written here (signaling payloads are relayed in memory only).
 *
 * State transitions are conditional UPDATEs (`WHERE state IN (...)`) that
 * report whether they applied, so two racing transitions (e.g. an accept
 * and a cancel) can never both succeed.
 */
export class CallsRepository {
  constructor(private readonly db: DatabaseClient) {}

  async createSession(input: {
    conversationId: string;
    initiatorId: string;
    scope: CallScope;
    media: CallMedia;
    inviteeIds: string[];
  }): Promise<CallDTO> {
    const callId = generateId();
    try {
      await this.db.withTransaction(async (tx) => {
        const live = await tx.query<{ id: string }>(
          `SELECT id FROM call_sessions WHERE conversation_id = $1 AND ended_at IS NULL`,
          [input.conversationId]
        );
        if (live.rows[0]) throw new LiveCallExistsError(live.rows[0].id);

        await tx.query(
          `INSERT INTO call_sessions (id, conversation_id, initiator_id, scope, media, state)
           VALUES ($1, $2, $3, $4, $5, 'ringing')`,
          [callId, input.conversationId, input.initiatorId, input.scope, input.media]
        );
        await tx.query(
          `INSERT INTO call_participants (call_id, user_id, role, state, joined_at)
           VALUES ($1, $2, 'initiator', 'joined', now())`,
          [callId, input.initiatorId]
        );
        for (const userId of input.inviteeIds) {
          await tx.query(
            `INSERT INTO call_participants (call_id, user_id, role, state) VALUES ($1, $2, 'invitee', 'invited')`,
            [callId, userId]
          );
        }
        await tx.query(`INSERT INTO call_events (id, call_id, actor_id, event_type) VALUES ($1, $2, $3, 'created')`, [
          generateId(),
          callId,
          input.initiatorId,
        ]);
      });
    } catch (err) {
      if (err instanceof LiveCallExistsError) throw err;
      // Lost a race with a concurrent start: the one-live-call-per-conversation unique index fired.
      const live = await this.findLiveByConversation(input.conversationId);
      if (live) throw new LiveCallExistsError(live.id);
      throw err;
    }
    return (await this.findById(callId))!;
  }

  async findById(callId: string): Promise<CallDTO | null> {
    const result = await this.db.query<SessionRow>(`SELECT ${SESSION_COLUMNS} FROM call_sessions WHERE id = $1`, [callId]);
    const row = result.rows[0];
    if (!row) return null;
    const participants = await this.participantsFor([row.id]);
    return toCall(row, participants.get(row.id) ?? []);
  }

  async findLiveByConversation(conversationId: string): Promise<CallDTO | null> {
    const result = await this.db.query<{ id: string }>(
      "SELECT id FROM call_sessions WHERE conversation_id = $1 AND ended_at IS NULL",
      [conversationId]
    );
    const id = result.rows[0]?.id;
    return id ? this.findById(id) : null;
  }

  /** IDs of live calls in which the user is currently joined. */
  async findLiveCallIdsJoinedBy(userId: string): Promise<string[]> {
    const result = await this.db.query<{ call_id: string }>(
      `SELECT p.call_id
       FROM call_participants p
       JOIN call_sessions s ON s.id = p.call_id
       WHERE p.user_id = $1 AND p.state = 'joined' AND s.ended_at IS NULL`,
      [userId]
    );
    return result.rows.map((row) => row.call_id);
  }

  /** Applies the patch only if the session is currently in one of `fromStates`. Returns whether it applied. */
  async transitionSession(callId: string, fromStates: CallState[], patch: SessionPatch): Promise<boolean> {
    const columns: Array<[string, unknown]> = [["state", patch.state]];
    if (patch.answeredAt !== undefined) columns.push(["answered_at", patch.answeredAt]);
    if (patch.connectedAt !== undefined) columns.push(["connected_at", patch.connectedAt]);
    if (patch.endedAt !== undefined) columns.push(["ended_at", patch.endedAt]);
    if (patch.endReason !== undefined) columns.push(["end_reason", patch.endReason]);
    if (patch.durationSeconds !== undefined) columns.push(["duration_seconds", patch.durationSeconds]);

    const setClauses = columns.map(([column], i) => `${column} = $${i + 2}`).join(", ");
    const params: unknown[] = [callId, ...columns.map(([, value]) => value), ...fromStates];
    const result = await this.db.query<{ id: string }>(
      `UPDATE call_sessions SET ${setClauses}, updated_at = now()
       WHERE id = $1 AND state IN (${placeholders(fromStates, columns.length + 1)})
       RETURNING id`,
      params
    );
    return result.rows.length > 0;
  }

  async insertParticipant(callId: string, userId: string, role: CallParticipantRole, state: CallParticipantState): Promise<void> {
    await this.db.query(`INSERT INTO call_participants (call_id, user_id, role, state) VALUES ($1, $2, $3, $4)`, [
      callId,
      userId,
      role,
      state,
    ]);
  }

  /** Moves one participant to `state` if they are currently in one of `fromStates`. Returns whether it applied. */
  async transitionParticipant(
    callId: string,
    userId: string,
    fromStates: CallParticipantState[],
    state: CallParticipantState
  ): Promise<boolean> {
    const timestamps =
      state === "joined" ? ", joined_at = now(), left_at = NULL" : state === "left" ? ", left_at = now()" : "";
    const result = await this.db.query<{ user_id: string }>(
      `UPDATE call_participants SET state = $3${timestamps}, updated_at = now()
       WHERE call_id = $1 AND user_id = $2 AND state IN (${placeholders(fromStates, 3)})
       RETURNING user_id`,
      [callId, userId, state, ...fromStates]
    );
    return result.rows.length > 0;
  }

  /** Bulk-moves every participant in one of `fromStates` (e.g. unanswered invitees → missed). */
  async transitionParticipants(callId: string, fromStates: CallParticipantState[], state: CallParticipantState): Promise<void> {
    const timestamps = state === "left" ? ", left_at = now()" : "";
    await this.db.query(
      `UPDATE call_participants SET state = $2${timestamps}, updated_at = now()
       WHERE call_id = $1 AND state IN (${placeholders(fromStates, 2)})`,
      [callId, state, ...fromStates]
    );
  }

  async addEvent(callId: string, actorId: string | null, eventType: CallEventType): Promise<void> {
    await this.db.query(`INSERT INTO call_events (id, call_id, actor_id, event_type) VALUES ($1, $2, $3, $4)`, [
      generateId(),
      callId,
      actorId,
      eventType,
    ]);
  }

  async listEventTypes(callId: string): Promise<CallEventType[]> {
    const result = await this.db.query<{ event_type: CallEventType }>(
      "SELECT event_type FROM call_events WHERE call_id = $1 ORDER BY created_at ASC",
      [callId]
    );
    return result.rows.map((row) => row.event_type);
  }

  /**
   * Calls the user was part of (invited to or started), newest first.
   * Optionally limited to one conversation, and paginated by `before`
   * (a call ID: only calls created strictly before it are returned).
   */
  async listForParticipant(
    userId: string,
    options: { conversationId?: string; limit: number; beforeCallId?: string }
  ): Promise<CallDTO[]> {
    const params: unknown[] = [userId];
    let filters = "";
    if (options.conversationId) {
      params.push(options.conversationId);
      filters += ` AND s.conversation_id = $${params.length}`;
    }
    if (options.beforeCallId) {
      params.push(options.beforeCallId);
      filters += ` AND s.created_at < (SELECT created_at FROM call_sessions WHERE id = $${params.length})`;
    }
    params.push(options.limit);

    // `IN (subquery)` rather than a JOIN: equivalent in PostgreSQL, and supported by pg-mem (the test engine).
    const result = await this.db.query<SessionRow>(
      `SELECT ${SESSION_COLUMNS}
       FROM call_sessions s
       WHERE s.id IN (SELECT call_id FROM call_participants WHERE user_id = $1)${filters}
       ORDER BY s.created_at DESC
       LIMIT $${params.length}`,
      params
    );
    const participants = await this.participantsFor(result.rows.map((row) => row.id));
    return result.rows.map((row) => toCall(row, participants.get(row.id) ?? []));
  }

  /**
   * Startup recovery: live-call bookkeeping (who is connected from which
   * device, ring timers) lives in process memory, so after a restart any
   * call still marked live in the database can no longer be signaled.
   * Mark them failed rather than leave phantom "ongoing" calls.
   */
  async failAllLive(reason: CallEndReason): Promise<number> {
    const live = await this.db.query<{ id: string }>(
      `UPDATE call_sessions SET state = 'failed', end_reason = $1, ended_at = now(), updated_at = now()
       WHERE state IN ${LIVE_STATES_SQL}
       RETURNING id`,
      [reason]
    );
    for (const row of live.rows) {
      await this.db.query(
        `UPDATE call_participants SET state = 'left', left_at = now(), updated_at = now() WHERE call_id = $1 AND state = 'joined'`,
        [row.id]
      );
      await this.db.query(
        `UPDATE call_participants SET state = 'missed', updated_at = now() WHERE call_id = $1 AND state IN ('invited', 'ringing')`,
        [row.id]
      );
    }
    return live.rows.length;
  }

  private async participantsFor(callIds: string[]): Promise<Map<string, CallParticipantDTO[]>> {
    const byCall = new Map<string, CallParticipantDTO[]>();
    if (callIds.length === 0) return byCall;
    const result = await this.db.query<ParticipantRow>(
      `SELECT p.call_id, p.user_id, u.display_name, pr.avatar_url, p.role, p.state, p.invited_at, p.joined_at, p.left_at
       FROM call_participants p
       JOIN users u ON u.id = p.user_id
       LEFT JOIN user_profiles pr ON pr.user_id = p.user_id
       WHERE p.call_id IN (${placeholders(callIds)})`,
      callIds
    );
    for (const row of result.rows) {
      const list = byCall.get(row.call_id) ?? [];
      list.push(toParticipant(row));
      byCall.set(row.call_id, list);
    }
    for (const list of byCall.values()) {
      // Initiator first, then invitees by name — a stable order for UIs.
      list.sort((a, b) => (a.role === b.role ? a.displayName.localeCompare(b.displayName) : a.role === "initiator" ? -1 : 1));
    }
    return byCall;
  }
}
