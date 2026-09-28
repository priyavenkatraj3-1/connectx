import { z } from "zod";
import { AppError } from "../../../middleware/errorHandler";
import type { MessagesRepository } from "../../messages/messages.repository";
import type { AISettingsService } from "../ai-settings.service";
import type { AIGateway } from "../ai.gateway";
import type { AIRepository } from "../ai.repository";
import type { AIGeneratedBy, HeuristicScamResult, RiskLevel } from "../ai.types";
import { renderSingleMessage, UNTRUSTED_DATA_RULES } from "../context/prompt-safety";
import { analyzeScamSignals, higherRisk } from "./scam-signals";

export const SCAM_DISCLAIMER =
  "This is an automated, AI-assisted warning based on common scam patterns. It can be wrong in both directions — it is not a verdict. Never share passwords or codes, and verify requests for money through another channel.";

export interface ScanFinding extends HeuristicScamResult {
  messageId: string;
}

export interface ScamCheckResult {
  messageId: string;
  riskLevel: RiskLevel;
  heuristic: HeuristicScamResult;
  ai: { riskLevel: RiskLevel; reasons: string[]; confidence: "low" | "medium" | "high" } | null;
  generatedBy: AIGeneratedBy | null;
  disclaimer: string;
}

const aiSchema = z.object({
  risk_level: z.enum(["likely_safe", "suspicious", "high_risk"]),
  reasons: z.array(z.string().min(1).max(300)).max(6),
  confidence: z.enum(["low", "medium", "high"]),
});

const aiJsonSchema = {
  type: "object",
  properties: {
    risk_level: { type: "string", enum: ["likely_safe", "suspicious", "high_risk"] },
    reasons: { type: "array", items: { type: "string" } },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
  },
  required: ["risk_level", "reasons", "confidence"],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You assess whether a chat message shows signs of a scam, phishing or spam, to help the recipient decide whether to be careful.

- Consider: suspicious links, requests for passwords/codes/personal data, requests for money (gift cards, crypto, fees), impersonation of banks/support/known people, pressure or threats, offers that are too good to be true.
- Ordinary messages between friends or colleagues are "likely_safe". Don't flag a message just because it mentions money or a link.
- Give short, concrete reasons a non-expert can check. Don't state that it definitely is a scam — you can't verify that.

${UNTRUSTED_DATA_RULES}

Respond with a single JSON object: {"risk_level": "likely_safe" | "suspicious" | "high_risk", "reasons": string[], "confidence": "low" | "medium" | "high"}.`;

/**
 * Scam/Spam Shield. `scan` is local heuristics only (no provider, no
 * content leaves the server) over messages the user can see, skipping
 * their own messages and ones they already dismissed or reported.
 * `aiCheck` is an explicit, per-message request that additionally asks the
 * AI provider. Warnings are advisory; messages are never blocked.
 */
export class ScamShieldService {
  constructor(
    private readonly settings: AISettingsService,
    private readonly repository: AIRepository,
    private readonly messagesRepository: MessagesRepository,
    private readonly gateway: AIGateway
  ) {}

  async scan(userId: string, conversationId: string, messageIds: string[]): Promise<ScanFinding[]> {
    await this.settings.require(userId, "spam_shield_local");
    // Membership only — local heuristics send nothing to a provider, so the AI exclusion list doesn't apply.
    const accessible = await this.repository.findAccessibleConversations(userId, [conversationId]);
    if (accessible.length === 0) throw new AppError("You do not have access to this conversation", 403);

    const unique = [...new Set(messageIds)];
    const rows = await this.repository.findVisibleMessages(userId, [conversationId], { messageIds: unique, limit: unique.length });
    const flagged = await this.repository.findFlaggedMessageIds(userId, rows.map((row) => row.id));

    const findings: ScanFinding[] = [];
    for (const row of rows) {
      if (row.senderId === userId || flagged.has(row.id)) continue;
      const result = analyzeScamSignals(row.body);
      if (result.riskLevel !== "likely_safe") findings.push({ messageId: row.id, ...result });
    }
    return findings;
  }

  private async requireVisibleMessage(userId: string, messageId: string) {
    const message = await this.messagesRepository.findRecordById(messageId);
    if (!message || !(await this.messagesRepository.isVisibleTo(messageId, userId))) {
      throw new AppError("Message not found", 404);
    }
    return message;
  }

  async aiCheck(userId: string, messageId: string): Promise<ScamCheckResult> {
    await this.settings.require(userId, "spam_shield_ai");
    const message = await this.requireVisibleMessage(userId, messageId);
    if ((await this.repository.listExclusions(userId)).includes(message.conversationId)) {
      throw new AppError("This conversation is excluded from AI in your settings", 400, true, "ai_conversation_excluded");
    }
    if (!message.body) throw new AppError("This message has no text to check", 400);

    const heuristic = analyzeScamSignals(message.body);
    const { data, provider, model } = await this.gateway.generateStructured(userId, "scam_shield", {
      system: SYSTEM_PROMPT,
      input: renderSingleMessage(message.body),
      maxOutputTokens: 1500,
      schema: aiSchema,
      jsonSchema: aiJsonSchema,
    });

    return {
      messageId,
      riskLevel: higherRisk(heuristic.riskLevel, data.risk_level),
      heuristic,
      ai: { riskLevel: data.risk_level, reasons: data.reasons.map((r) => r.trim()), confidence: data.confidence },
      generatedBy: { provider, model },
      disclaimer: SCAM_DISCLAIMER,
    };
  }

  /** Records that the user dismissed or reported a warning. A report is stored for review; no moderation pipeline exists yet. */
  async feedback(userId: string, messageId: string, action: "dismissed" | "reported"): Promise<void> {
    const message = await this.requireVisibleMessage(userId, messageId);
    const risk = message.body ? analyzeScamSignals(message.body).riskLevel : null;
    await this.repository.saveMessageFlag(userId, messageId, action, risk);
  }
}
