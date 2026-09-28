import { z } from "zod";
import type { AISettingsService } from "../ai-settings.service";
import type { AIGateway } from "../ai.gateway";
import type { AIRepository } from "../ai.repository";
import type { AIGeneratedBy, AISourceReference } from "../ai.types";
import type { AIContextService } from "../context/ai-context.service";
import { normalizeQuestion, renderMemoryBlock, renderMessagesBlock, UNTRUSTED_DATA_RULES } from "../context/prompt-safety";

export interface AskResult {
  status: "answered" | "insufficient_information";
  answer: string;
  sources: AISourceReference[];
  /** Null when no AI call was made (e.g. nothing to search). */
  generatedBy: AIGeneratedBy | null;
  contextMessageCount: number;
  usedMemory: boolean;
}

export const NOT_ENOUGH_INFORMATION = "There isn't enough information in the selected chats to answer that.";
const NO_SUPPORTED_ANSWER =
  "The AI couldn't point to specific messages that support an answer, so no answer is shown. Try rephrasing or selecting different chats.";

const answerSchema = z.object({
  status: z.enum(["answered", "insufficient_information"]),
  answer: z.string().max(6000),
  source_refs: z.array(z.string().max(16)).max(20),
});

const answerJsonSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["answered", "insufficient_information"] },
    answer: { type: "string" },
    source_refs: { type: "array", items: { type: "string" } },
  },
  required: ["status", "answer", "source_refs"],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You are ConnectX's "Ask Your Chats" assistant. You answer the user's question using ONLY the chat messages provided.

- Base every statement on the provided messages. Do not use outside knowledge about the people or events.
- If the messages don't contain enough evidence, set status to "insufficient_information" and briefly say what is missing.
- List in source_refs the reference ids (e.g. "M4") of the messages that support your answer.
- Be concise. Use the people's names as they appear in the messages. Dates in the data are ISO-8601 UTC.
- User memory items (if any) are notes the user saved about their own preferences or context; use them only to interpret the question.

${UNTRUSTED_DATA_RULES}

Respond with a single JSON object: {"status": "answered" | "insufficient_information", "answer": string, "source_refs": string[]}.`;

export class AskYourChatsService {
  constructor(
    private readonly settings: AISettingsService,
    private readonly context: AIContextService,
    private readonly repository: AIRepository,
    private readonly gateway: AIGateway
  ) {}

  async ask(userId: string, input: { question: string; conversationIds: string[]; useMemory?: boolean }): Promise<AskResult> {
    const settings = await this.settings.require(userId, "chat_retrieval");
    const conversations = await this.context.authorize(userId, input.conversationIds);
    const question = normalizeQuestion(input.question);

    const messages = await this.context.retrieveRelevant(userId, conversations, question);
    if (messages.length === 0) {
      return {
        status: "insufficient_information",
        answer: NOT_ENOUGH_INFORMATION,
        sources: [],
        generatedBy: null,
        contextMessageCount: 0,
        usedMemory: false,
      };
    }

    const useMemory = settings.aiMemoryEnabled && input.useMemory !== false;
    const memories = useMemory ? (await this.repository.listMemories(userId, 30)).map((m) => ({ type: m.type, content: m.content })) : [];

    const promptInput = [
      `Current time (UTC): ${new Date().toISOString()}`,
      `Chats searched: ${conversations.map((c) => c.title).join("; ")}`,
      renderMemoryBlock(memories),
      renderMessagesBlock(messages),
      `The user's question (answer it using only the messages above):\n${JSON.stringify(question)}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    const { data, provider, model } = await this.gateway.generateStructured(userId, "ask_your_chats", {
      system: SYSTEM_PROMPT,
      input: promptInput,
      schema: answerSchema,
      jsonSchema: answerJsonSchema,
    });

    const sources = this.context.resolveRefs(data.source_refs, messages);
    const generatedBy = { provider, model };

    if (data.status === "insufficient_information") {
      return {
        status: "insufficient_information",
        answer: data.answer.trim() || NOT_ENOUGH_INFORMATION,
        sources,
        generatedBy,
        contextMessageCount: messages.length,
        usedMemory: memories.length > 0,
      };
    }
    // An "answer" that can't be tied to a single real message isn't shown as one.
    if (sources.length === 0) {
      return {
        status: "insufficient_information",
        answer: NO_SUPPORTED_ANSWER,
        sources: [],
        generatedBy,
        contextMessageCount: messages.length,
        usedMemory: memories.length > 0,
      };
    }
    return {
      status: "answered",
      answer: data.answer.trim(),
      sources,
      generatedBy,
      contextMessageCount: messages.length,
      usedMemory: memories.length > 0,
    };
  }
}
