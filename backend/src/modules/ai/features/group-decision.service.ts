import { z } from "zod";
import { AppError } from "../../../middleware/errorHandler";
import type { AISettingsService } from "../ai-settings.service";
import type { AIGateway } from "../ai.gateway";
import type { AIGeneratedBy, AISourceReference } from "../ai.types";
import type { AIContextService } from "../context/ai-context.service";
import { renderMessagesBlock, UNTRUSTED_DATA_RULES } from "../context/prompt-safety";

export type DecisionMode = "summary" | "decisions" | "open_issues";

export interface DecisionPoint {
  text: string;
  sources: AISourceReference[];
}

export interface DecisionSummary {
  mode: DecisionMode;
  /** False when there were no messages to analyze (no AI call was made). */
  hasContent: boolean;
  summary: string;
  proposals: DecisionPoint[];
  agreements: DecisionPoint[];
  disagreements: DecisionPoint[];
  openQuestions: DecisionPoint[];
  decisions: DecisionPoint[];
  actionItems: DecisionPoint[];
  generatedBy: AIGeneratedBy | null;
  messageCount: number;
  /** Items the model returned without a valid source, which were removed. */
  droppedUnsupportedItems: number;
}

const itemSchema = z.object({ text: z.string().min(1).max(500), source_refs: z.array(z.string().max(16)).max(10) });
const summarySchema = z.object({
  summary: z.string().max(3000),
  proposals: z.array(itemSchema).max(15),
  agreements: z.array(itemSchema).max(15),
  disagreements: z.array(itemSchema).max(15),
  open_questions: z.array(itemSchema).max(15),
  decisions: z.array(itemSchema).max(15),
  action_items: z.array(itemSchema).max(15),
});

const itemJsonSchema = {
  type: "object",
  properties: { text: { type: "string" }, source_refs: { type: "array", items: { type: "string" } } },
  required: ["text", "source_refs"],
  additionalProperties: false,
};
const summaryJsonSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    proposals: { type: "array", items: itemJsonSchema },
    agreements: { type: "array", items: itemJsonSchema },
    disagreements: { type: "array", items: itemJsonSchema },
    open_questions: { type: "array", items: itemJsonSchema },
    decisions: { type: "array", items: itemJsonSchema },
    action_items: { type: "array", items: itemJsonSchema },
  },
  required: ["summary", "proposals", "agreements", "disagreements", "open_questions", "decisions", "action_items"],
  additionalProperties: false,
};

const FOCUS: Record<DecisionMode, string> = {
  summary: "Focus: an overall summary of the discussion, with every section filled where the messages support it.",
  decisions: "Focus: what the group actually decided. Be strict — a decision needs explicit agreement in the messages.",
  open_issues: "Focus: unresolved questions and points of disagreement that still need an answer.",
};

const SYSTEM_PROMPT = `You are ConnectX's Group Decision assistant. You analyze a group chat discussion using ONLY the provided messages.

Rules for honesty:
- A "decision" requires explicit agreement in the messages (e.g. people confirming, or an organizer stating the outcome with no objection). A proposal nobody confirmed is a proposal, not a decision.
- Never claim the group reached consensus unless the messages show it. If only some people agreed, say who.
- Every item must cite the reference ids (e.g. "M3") of the messages that support it. Items without support must be left out.
- Leave a section empty rather than guessing.

${UNTRUSTED_DATA_RULES}

Respond with a single JSON object with keys: summary (string), proposals, agreements, disagreements, open_questions, decisions, action_items (each an array of {"text": string, "source_refs": string[]}).`;

export class GroupDecisionService {
  constructor(
    private readonly settings: AISettingsService,
    private readonly context: AIContextService,
    private readonly gateway: AIGateway
  ) {}

  async summarize(userId: string, conversationId: string, mode: DecisionMode): Promise<DecisionSummary> {
    await this.settings.require(userId, "chat_retrieval");
    const [conversation] = await this.context.authorize(userId, [conversationId]);
    if (conversation!.type !== "group") {
      throw new AppError("Group Decision AI works on group conversations. Use Ask Your Chats for direct chats.", 400);
    }

    const messages = await this.context.retrieveRecent(userId, [conversation!], 200);
    const empty: DecisionSummary = {
      mode,
      hasContent: false,
      summary: "There are no messages to analyze in this group yet.",
      proposals: [],
      agreements: [],
      disagreements: [],
      openQuestions: [],
      decisions: [],
      actionItems: [],
      generatedBy: null,
      messageCount: 0,
      droppedUnsupportedItems: 0,
    };
    if (messages.length === 0) return empty;

    const { data, provider, model } = await this.gateway.generateStructured(userId, "group_decision", {
      system: SYSTEM_PROMPT,
      input: [
        `Group: ${JSON.stringify(conversation!.title)}`,
        FOCUS[mode],
        renderMessagesBlock(messages),
        "Analyze the discussion above.",
      ].join("\n\n"),
      schema: summarySchema,
      jsonSchema: summaryJsonSchema,
    });

    let dropped = 0;
    const supported = (items: Array<{ text: string; source_refs: string[] }>): DecisionPoint[] =>
      items.flatMap((item) => {
        const sources = this.context.resolveRefs(item.source_refs, messages);
        if (sources.length === 0) {
          dropped += 1;
          return [];
        }
        return [{ text: item.text.trim(), sources }];
      });

    return {
      mode,
      hasContent: true,
      summary: data.summary.trim(),
      proposals: supported(data.proposals),
      agreements: supported(data.agreements),
      disagreements: supported(data.disagreements),
      openQuestions: supported(data.open_questions),
      decisions: supported(data.decisions),
      actionItems: supported(data.action_items),
      generatedBy: { provider, model },
      messageCount: messages.length,
      droppedUnsupportedItems: dropped,
    };
  }
}
