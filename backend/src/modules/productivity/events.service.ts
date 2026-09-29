import type { DatabaseClient } from "../../db/pool";
import { AppError } from "../../middleware/errorHandler";
import type { RealtimeGateway } from "../../realtime/gateway.interface";
import { resolveDateInput } from "../../utils/datetime";
import { generateId } from "../../utils/id";
import type { PreferencesService } from "../preferences/preferences.service";
import type { CalendarEventDTO } from "./productivity.types";
import type { CreateEventInput, UpdateEventInput } from "./productivity.validation";
import { sourceExcerptJoin, toSourceReference, type SourceResolver } from "./source";

interface EventRow {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  starts_at: Date;
  ends_at: Date | null;
  all_day: boolean;
  timezone: string | null;
  source_conversation_id: string | null;
  source_message_id: string | null;
  source_action_id: string | null;
  source_excerpt: string | null;
  created_at: Date;
  updated_at: Date;
}

function toDTO(row: EventRow): CalendarEventDTO {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    location: row.location,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    allDay: row.all_day,
    timezone: row.timezone,
    source: toSourceReference(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Private calendar events. ConnectX does not sync them to external calendars or send invites. */
export class EventsService {
  constructor(
    private readonly db: DatabaseClient,
    private readonly gateway: RealtimeGateway,
    private readonly preferences: PreferencesService,
    private readonly sources: SourceResolver
  ) {}

  async get(userId: string, eventId: string): Promise<CalendarEventDTO> {
    const excerpt = sourceExcerptJoin("e", "$2");
    const result = await this.db.query<EventRow>(
      `SELECT e.*, ${excerpt.select} FROM calendar_events e ${excerpt.joins} WHERE e.id = $1 AND e.user_id = $2`,
      [eventId, userId]
    );
    const row = result.rows[0];
    if (!row) throw new AppError("Event not found", 404);
    return toDTO(row);
  }

  async list(userId: string, range: { from?: string; to?: string }): Promise<CalendarEventDTO[]> {
    const excerpt = sourceExcerptJoin("e", "$1");
    const params: unknown[] = [userId];
    let filter = "";
    if (range.from) {
      params.push(new Date(range.from));
      filter += ` AND (e.starts_at >= $${params.length} OR (e.ends_at IS NOT NULL AND e.ends_at >= $${params.length}))`;
    }
    if (range.to) {
      params.push(new Date(range.to));
      filter += ` AND e.starts_at <= $${params.length}`;
    }
    const result = await this.db.query<EventRow>(
      `SELECT e.*, ${excerpt.select} FROM calendar_events e ${excerpt.joins}
       WHERE e.user_id = $1 ${filter} ORDER BY e.starts_at ASC LIMIT 500`,
      params
    );
    return result.rows.map(toDTO);
  }

  async create(userId: string, input: CreateEventInput): Promise<CalendarEventDTO> {
    const timezone = input.timezone ?? (await this.preferences.getTimezone(userId));
    const startsAt = resolveDateInput("startsAt", input.startsAt, input.startsAtLocal, timezone);
    if (!startsAt) throw new AppError("startsAt is required", 400);
    const endsAt = resolveDateInput("endsAt", input.endsAt, input.endsAtLocal, timezone) ?? null;
    if (endsAt && endsAt < startsAt) throw new AppError("endsAt must be after startsAt", 400);
    const source = await this.sources.resolve(userId, input);

    const id = generateId();
    await this.db.withTransaction(async (tx) => {
      await tx.query(
        `INSERT INTO calendar_events (id, user_id, title, description, location, starts_at, ends_at, all_day, timezone,
                                      source_conversation_id, source_message_id, source_action_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [id, userId, input.title, input.description ?? null, input.location ?? null, startsAt, endsAt, input.allDay ?? false,
         timezone ?? null, source.conversationId, source.messageId, source.actionId]
      );
      if (source.actionId) await this.sources.claimAction(tx, userId, source.actionId, "event", id);
    });
    return this.publish(userId, id);
  }

  async update(userId: string, eventId: string, input: UpdateEventInput): Promise<CalendarEventDTO> {
    const existing = await this.get(userId, eventId);
    const timezone = input.timezone !== undefined ? input.timezone : (existing.timezone ?? (await this.preferences.getTimezone(userId)));
    const startsAt = resolveDateInput("startsAt", input.startsAt, input.startsAtLocal, timezone);
    const endsAt = resolveDateInput("endsAt", input.endsAt, input.endsAtLocal, timezone);
    const finalStart = startsAt ?? existing.startsAt;
    const finalEnd = endsAt !== undefined ? endsAt : existing.endsAt;
    if (finalEnd && new Date(finalEnd) < new Date(finalStart)) throw new AppError("endsAt must be after startsAt", 400);

    const sets: string[] = [];
    const params: unknown[] = [eventId, userId];
    const push = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (input.title !== undefined) push("title", input.title);
    if (input.description !== undefined) push("description", input.description);
    if (input.location !== undefined) push("location", input.location);
    if (input.allDay !== undefined) push("all_day", input.allDay);
    if (input.timezone !== undefined) push("timezone", input.timezone);
    if (startsAt) push("starts_at", startsAt);
    if (endsAt !== undefined) push("ends_at", endsAt);
    if (sets.length > 0) {
      await this.db.query(`UPDATE calendar_events SET ${sets.join(", ")}, updated_at = now() WHERE id = $1 AND user_id = $2`, params);
    }
    return this.publish(userId, eventId);
  }

  async remove(userId: string, eventId: string): Promise<void> {
    await this.get(userId, eventId);
    await this.db.query("DELETE FROM calendar_events WHERE id = $1 AND user_id = $2", [eventId, userId]);
    this.gateway.sendToUser(userId, { type: "calendar_event:deleted", eventId });
  }

  private async publish(userId: string, eventId: string): Promise<CalendarEventDTO> {
    const event = await this.get(userId, eventId);
    this.gateway.sendToUser(userId, { type: "calendar_event:updated", event });
    return event;
  }
}
