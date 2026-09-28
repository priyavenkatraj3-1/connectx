import { AppError } from "../../middleware/errorHandler";
import type { ConversationsRepository } from "../conversations/conversations.repository";
import type { AIGateway } from "./ai.gateway";
import type { AIRepository } from "./ai.repository";
import type { AISettings } from "./ai.types";
import { AIDisabledError } from "./ai.errors";
import { SUPPORTED_LANGUAGES } from "./languages";

export type AISettingsUpdate = Partial<Omit<AISettings, "consentedAt">>;

/** What a gated operation needs, beyond the provider being configured. */
export type AIRequirement =
  /** Reads chat content and sends it to the text provider. */
  | "chat_retrieval"
  /** Sends one message to the text provider. */
  | "provider"
  /** Stores an explicit memory item. */
  | "memory_write"
  /** Local scam heuristics — no provider involved. */
  | "spam_shield_local"
  /** Sends one message to the text provider for a scam check. */
  | "spam_shield_ai"
  /** Sends audio to the transcription provider. */
  | "voice";

/** Plain-language disclosure of what leaves the server, shown in Settings. Kept next to the gating code on purpose. */
export const DATA_SHARING_DISCLOSURE = [
  "Ask Your Chats, Group Decision AI and Smart Actions send the question plus a bounded selection of messages (sender name, time, text) from the chats you select to the configured AI provider.",
  "Translation sends only the one message you ask to translate.",
  "The AI scam check sends only the one message you ask to check. Automatic scam warnings run on the ConnectX server and send nothing to an AI provider.",
  "Voice Intelligence sends the audio of the voice message you choose to the transcription provider, and the transcript to the AI provider for a summary.",
  "When AI Memory is on, your saved memory items are included with Ask Your Chats questions.",
  "ConnectX logs AI usage metadata (feature, time, token counts, success/failure) — never your questions, messages or AI answers.",
];

export class AISettingsService {
  constructor(
    private readonly repository: AIRepository,
    private readonly conversationsRepository: ConversationsRepository,
    private readonly gateway: AIGateway
  ) {}

  getSettings(userId: string): Promise<AISettings> {
    return this.repository.getSettings(userId);
  }

  getServerStatus() {
    return {
      provider: this.gateway.providerStatus,
      transcription: this.gateway.transcriptionStatus,
      supportedLanguages: SUPPORTED_LANGUAGES,
      dataSharing: DATA_SHARING_DISCLOSURE,
    };
  }

  async updateSettings(userId: string, update: AISettingsUpdate): Promise<AISettings> {
    const current = await this.repository.getSettings(userId);
    const next: AISettings = { ...current, ...update };
    if (update.aiFeaturesEnabled === true && !current.aiFeaturesEnabled) next.consentedAt = new Date();
    await this.repository.saveSettings(userId, next);
    return this.repository.getSettings(userId);
  }

  /**
   * Enforces consent (403 `ai_disabled`) and then provider configuration
   * (503 `ai_not_configured`). Order matters: a user who hasn't opted in
   * learns how to opt in; one who has learns the server isn't set up.
   */
  async require(userId: string, requirement: AIRequirement): Promise<AISettings> {
    const settings = await this.repository.getSettings(userId);

    if (requirement === "spam_shield_local") {
      if (!settings.spamShieldEnabled) throw new AIDisabledError("Turn on Scam/Spam Shield in Settings → AI Features.");
      return settings;
    }
    if (requirement === "memory_write") {
      if (!settings.aiMemoryEnabled) throw new AIDisabledError("Turn on AI Memory in Settings → AI Features to save memories.");
      return settings;
    }

    if (!settings.aiFeaturesEnabled) throw new AIDisabledError();
    if (requirement === "chat_retrieval" && !settings.chatRetrievalEnabled) {
      throw new AIDisabledError("Allow AI to read your chats in Settings → AI Features to use this.");
    }
    if (requirement === "spam_shield_ai" && !settings.spamShieldEnabled) {
      throw new AIDisabledError("Turn on Scam/Spam Shield in Settings → AI Features.");
    }
    if (requirement === "voice") {
      if (!settings.voiceEnabled) throw new AIDisabledError("Turn on Voice Intelligence in Settings → AI Features.");
      this.gateway.requireTranscriptionProvider();
      return settings;
    }
    this.gateway.requireTextProvider();
    return settings;
  }

  listExclusions(userId: string): Promise<string[]> {
    return this.repository.listExclusions(userId);
  }

  async setExclusion(userId: string, conversationId: string, excluded: boolean): Promise<string[]> {
    if (excluded) {
      if (!(await this.conversationsRepository.isMember(conversationId, userId))) {
        throw new AppError("You do not have access to this conversation", 403);
      }
      await this.repository.addExclusion(userId, conversationId);
    } else {
      // Removing is always allowed (even after leaving), so a user can clean up their own settings.
      await this.repository.removeExclusion(userId, conversationId);
    }
    return this.repository.listExclusions(userId);
  }
}
