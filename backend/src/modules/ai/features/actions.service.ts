import { z } from "zod";
import { AppError } from "../../../middleware/errorHandler";
import type { AISettingsService } from "../ai-settings.service";
import type { AIGateway } from "../ai.gateway";
import type { ActionUpdate, AIRepository, NewActionInput } from "../ai.repository";
import type { ActionStatus, AIActionDTO, AIGeneratedBy } from "../ai.types";
import type { AIContextService, ContextMessage } from "../context/ai-context.service";
import { renderMessagesBlock, UNTRUSTED_DATA_RULES } from "../context/prompt-safety";

const ACTION_TYPES = ["task", "reminder", "deadline", "event", "follow_up", "action_item"] as const;

const extractedSchema = z.object({
  actions: z
    .array(
      z.object({
        type: z.enum(ACTION_TYPES),
        title: z.string().min(1).max(300),
        due_iso: z.string().max(64).nullable(),
        due_text: z.string().max(200).nullable(),
        timezone: z.string().max(64).nullable(),
        participants: z.array(z.string().max(100)).max(20),
        source_ref: z.string().max(16),
        confidence: z.enum(["low", "medium", "high"]),
        explanation: z.string().max(600),
      })
    )
    .max(20),
});

const extractedJsonSchema = {
  type: "object",
  properties: {
    actions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: [...ACTION_TYPES] },
          title: { type: "string" },
          due_iso: { type: ["string", "null"] },
          due_text: { type: ["string", "null"] },
          timezone: { type: ["string", "null"] },
          participants: { type: "array", items: { type: "string" } },
          source_ref: { type: "string" },
          confidence: { type: "string", enum: ["low", "medium", "high"] },
          explanation: { type: "string" },
        },
        required: ["type", "title", "due_iso", "due_text", "timezone", "participants", "source_ref", "confidence", "explanation"],
        additionalProperties: false,
      },
    },
  },
  required: ["actions"],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You are ConnectX's Smart Action assistant. You detect possible tasks, reminders, deadlines, events, follow-ups and action items in the provided chat messages.

- Only report actions that are clearly stated or requested in a specific message. Cite it in source_ref (e.g. "M2").
- title: a short imperative description ("Send the report").
- due_iso: an ISO-8601 date-time ONLY if the message gives a date/time you can resolve with confidence relative to the message's sent_at; otherwise null. Always copy the original wording (e.g. "Friday at 3 PM") into due_text.
- timezone: an IANA zone only if one is stated or provided below; otherwise null.
- participants: only names explicitly written in that message. Never guess.
- confidence and a one-sentence explanation of why this looks like an action.
- These are suggestions shown to the user; they will confirm or dismiss each one. Return an empty list if there are none.

${UNTRUSTED_DATA_RULES}

Respond with a single JSON object: {"actions": [...]}.`;

function isValidTimezone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function parseDue(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const year = date.getUTCFullYear();
  return year >= 2000 && year <= 2100 ? date : null;
}

export interface ExtractionResult {
  actions: AIActionDTO[];
  generatedBy: AIGeneratedBy | null;
  messageCount: number;
}

/**
 * AI-assisted action detection. Output is validated, tied to a real source
 * message, and stored only as a *suggestion*. Nothing is scheduled or
 * created elsewhere: a suggestion becomes "confirmed" only by an explicit
 * user request, and confirmed rows are the handoff to Phase 6's
 * task/reminder system.
 */
export class SmartActionsService {
  constructor(
    private readonly settings: AISettingsService,
    private readonly context: AIContextService,
    private readonly repository: AIRepository,
    private readonly gateway: AIGateway
  ) {}

  async extract(
    userId: string,
    conversationId: string,
    input: { messageIds?: string[]; timezone?: string }
  ): Promise<ExtractionResult> {
    await this.settings.require(userId, "chat_retrieval");
    const [conversation] = await this.context.authorize(userId, [conversationId]);
    if (input.timezone && !isValidTimezone(input.timezone)) throw new AppError("Unknown timezone", 400);

    const messages =
      input.messageIds && input.messageIds.length > 0
        ? await this.context.retrieveByIds(userId, conversation!, input.messageIds)
        : await this.context.retrieveRecent(userId, [conversation!], 50);
    if (messages.length === 0) return { actions: [], generatedBy: null, messageCount: 0 };

    const { data, provider, model } = await this.gateway.generateStructured(userId, "action_extraction", {
      system: SYSTEM_PROMPT,
      input: [
        `Current time (UTC): ${new Date().toISOString()}`,
        input.timezone ? `The user's timezone: ${input.timezone}` : "The user's timezone is unknown.",
        renderMessagesBlock(messages),
        "Detect actions in the messages above.",
      ].join("\n\n"),
      schema: extractedSchema,
      jsonSchema: extractedJsonSchema,
    });

    const suggestions = this.validate(data.actions, messages, conversationId);
    const actions = await this.repository.insertSuggestedActions(userId, suggestions);
    return { actions, generatedBy: { provider, model }, messageCount: messages.length };
  }

  /** Semantic checks on top of the schema: real source message, explicit participants, sane dates/zones. */
  private validate(
    extracted: z.infer<typeof extractedSchema>["actions"],
    messages: ContextMessage[],
    conversationId: string
  ): NewActionInput[] {
    const byRef = new Map(messages.map((message) => [message.ref, message]));
    const results: NewActionInput[] = [];
    for (const action of extracted.slice(0, 10)) {
      const source = byRef.get(action.source_ref.trim());
      if (!source) continue;
      const lowerText = source.text.toLowerCase();
      const participants = [...new Set(action.participants.map((p) => p.trim()).filter(Boolean))].filter((name) =>
        lowerText.includes(name.toLowerCase())
      );
      results.push({
        conversationId,
        sourceMessageId: source.messageId,
        type: action.type,
        title: action.title.trim().slice(0, 200),
        dueAt: parseDue(action.due_iso),
        dueText: action.due_text?.trim().slice(0, 120) || null,
        timezone: action.timezone && isValidTimezone(action.timezone) ? action.timezone : null,
        participants,
        confidence: action.confidence,
        explanation: action.explanation.trim().slice(0, 500) || null,
      });
    }
    return results;
  }

  list(userId: string, filters: { status?: ActionStatus; conversationId?: string }): Promise<AIActionDTO[]> {
    return this.repository.listActions(userId, filters);
  }

  private async requireOwn(userId: string, actionId: string): Promise<AIActionDTO> {
    const action = await this.repository.findAction(userId, actionId);
    if (!action) throw new AppError("Action not found", 404);
    return action;
  }

  async update(userId: string, actionId: string, update: ActionUpdate): Promise<AIActionDTO> {
    const action = await this.requireOwn(userId, actionId);
    if (action.status === "dismissed") throw new AppError("This suggestion was dismissed", 409);
    if (update.timezone && !isValidTimezone(update.timezone)) throw new AppError("Unknown timezone", 400);
    return (await this.repository.updateAction(userId, actionId, update))!;
  }

  /** The only way a suggestion becomes an accepted action. Recorded for Phase 6; nothing is scheduled yet. */
  async confirm(userId: string, actionId: string): Promise<AIActionDTO> {
    const action = await this.requireOwn(userId, actionId);
    if (action.status === "dismissed") throw new AppError("This suggestion was dismissed", 409);
    return (await this.repository.setActionStatus(userId, actionId, "confirmed"))!;
  }

  async dismiss(userId: string, actionId: string): Promise<AIActionDTO> {
    await this.requireOwn(userId, actionId);
    return (await this.repository.setActionStatus(userId, actionId, "dismissed"))!;
  }
}
