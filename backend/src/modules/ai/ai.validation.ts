import { z } from "zod";
import { isSupportedLanguage, isVoiceTranslationLanguage } from "./languages";

/** Request-size limits for AI endpoints. They bound cost as much as abuse. */
export const AI_LIMITS = {
  questionMaxChars: 500,
  maxConversationsPerQuestion: 10,
  memoryMaxChars: 500,
  maxMessagesForExtraction: 50,
  maxMessagesPerScan: 100,
} as const;

const uuid = (label: string) => z.string().uuid(`${label} must be a valid ID`);

export const settingsUpdateSchema = z
  .object({
    aiFeaturesEnabled: z.boolean().optional(),
    aiMemoryEnabled: z.boolean().optional(),
    chatRetrievalEnabled: z.boolean().optional(),
    spamShieldEnabled: z.boolean().optional(),
    voiceEnabled: z.boolean().optional(),
    preferredLanguage: z
      .string()
      .refine(isSupportedLanguage, "Unsupported language")
      .optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: "Nothing to update" });

export const askSchema = z
  .object({
    question: z.string().trim().min(1, "Ask a question").max(AI_LIMITS.questionMaxChars, "Question is too long"),
    conversationIds: z
      .array(uuid("conversationIds"))
      .min(1, "Select at least one conversation")
      .max(AI_LIMITS.maxConversationsPerQuestion, `Select at most ${AI_LIMITS.maxConversationsPerQuestion} conversations`),
    useMemory: z.boolean().optional(),
  })
  .strict();

export const memoryCreateSchema = z
  .object({
    type: z.enum(["preference", "fact", "context", "working"]),
    content: z.string().trim().min(1, "Memory can't be empty").max(AI_LIMITS.memoryMaxChars, "Memory is too long"),
    sourceMessageId: uuid("sourceMessageId").optional(),
  })
  .strict();

export const extractActionsSchema = z
  .object({
    messageIds: z.array(uuid("messageIds")).max(AI_LIMITS.maxMessagesForExtraction).optional(),
    timezone: z.string().min(1).max(64).optional(),
  })
  .strict();

export const actionUpdateSchema = z
  .object({
    type: z.enum(["task", "reminder", "deadline", "event", "follow_up", "action_item"]).optional(),
    title: z.string().trim().min(1).max(200).optional(),
    notes: z.string().trim().max(1000).nullable().optional(),
    dueAt: z.string().datetime({ offset: true }).nullable().optional(),
    dueText: z.string().trim().max(120).nullable().optional(),
    timezone: z.string().max(64).nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: "Nothing to update" });

export const listActionsQuerySchema = z.object({
  status: z.enum(["suggested", "confirmed", "dismissed"]).optional(),
  conversationId: uuid("conversationId").optional(),
});

export const decisionSummarySchema = z
  .object({ mode: z.enum(["summary", "decisions", "open_issues"]).default("summary") })
  .strict();

export const translateSchema = z.object({ targetLanguage: z.string().trim().min(2).max(16) }).strict();

export const safetyScanSchema = z
  .object({ messageIds: z.array(uuid("messageIds")).min(1).max(AI_LIMITS.maxMessagesPerScan) })
  .strict();

export const safetyFeedbackSchema = z.object({ action: z.enum(["dismissed", "reported"]) }).strict();

export const transcribeSchema = z
  .object({ languageHint: z.string().regex(/^[a-z]{2,3}$/, "languageHint must be a language code like \"en\"").optional() })
  .strict();

export const voiceTranslateSchema = z
  .object({
    targetLanguage: z
      .string()
      .trim()
      .refine(isVoiceTranslationLanguage, "Voice messages can be translated into Tamil (ta), English (en), Hindi (hi), Telugu (te) or Malayalam (ml)"),
  })
  .strict();

export const conversationParamsSchema =z.object({ conversationId: uuid("conversationId") });
export const messageParamsSchema = z.object({ messageId: uuid("messageId") });
export const memoryParamsSchema = z.object({ memoryId: uuid("memoryId") });
export const actionParamsSchema = z.object({ actionId: uuid("actionId") });
export const attachmentParamsSchema = z.object({ attachmentId: uuid("attachmentId") });

export type SettingsUpdateInput = z.infer<typeof settingsUpdateSchema>;
export type AskInput = z.infer<typeof askSchema>;
export type MemoryCreateInput = z.infer<typeof memoryCreateSchema>;
export type ExtractActionsInput = z.infer<typeof extractActionsSchema>;
export type ActionUpdateInput = z.infer<typeof actionUpdateSchema>;
export type DecisionSummaryInput = z.infer<typeof decisionSummarySchema>;
