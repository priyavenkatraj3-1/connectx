import { AppError } from "../../middleware/errorHandler";
import type { RealtimeGateway } from "../../realtime/gateway.interface";
import type { Conversation, ConversationService } from "./conversation.interface";
import type { ConversationsRepository } from "./conversations.repository";
import type { ChatPreferences, ConversationSummary, MuteOption } from "./conversations.types";

/** Most chats one person can pin. */
export const MAX_PINNED_CHATS = 5;
/** "Mute until I unmute" is stored as a far-future time, so muted_until stays a single comparable column. */
const MUTED_FOREVER = new Date("9999-12-31T00:00:00.000Z");
const MUTE_DURATION_MS: Record<Exclude<MuteOption, "always" | "off">, number> = { "8h": 8 * 3_600_000, "1w": 7 * 86_400_000 };

export class ConversationsService implements ConversationService {
  constructor(
    private readonly conversationsRepository: ConversationsRepository,
    private readonly realtimeGateway?: RealtimeGateway,
    private readonly now: () => Date = () => new Date()
  ) {}

  /**
   * Updates your own pin/archive/mute settings for a chat you're an active
   * member of (404 otherwise). Archiving unpins; pinning unarchives. Your
   * other devices are told so their chat lists match.
   */
  async updateChatPreferences(
    conversationId: string,
    userId: string,
    input: { pinned?: boolean; archived?: boolean; mute?: MuteOption }
  ): Promise<ChatPreferences> {
    const current = await this.conversationsRepository.getChatPreferences(conversationId, userId);
    if (!current) throw new AppError("Conversation not found", 404);
    if (input.pinned && input.archived) throw new AppError("A chat can't be pinned and archived at the same time", 400);

    const now = this.now();
    const changes: { pinnedAt?: Date | null; archivedAt?: Date | null; mutedUntil?: Date | null } = {};
    if (input.pinned !== undefined && input.pinned !== current.pinned) {
      if (input.pinned && (await this.conversationsRepository.countPinned(userId)) >= MAX_PINNED_CHATS) {
        throw new AppError(`You can pin up to ${MAX_PINNED_CHATS} chats`, 400);
      }
      changes.pinnedAt = input.pinned ? now : null;
      if (input.pinned && current.archived) changes.archivedAt = null;
    }
    if (input.archived !== undefined && input.archived !== current.archived) {
      changes.archivedAt = input.archived ? now : null;
      if (input.archived && current.pinned) changes.pinnedAt = null;
    }
    if (input.mute !== undefined) {
      changes.mutedUntil =
        input.mute === "off" ? null : input.mute === "always" ? MUTED_FOREVER : new Date(now.getTime() + MUTE_DURATION_MS[input.mute]);
    }

    await this.conversationsRepository.updateChatPreferences(conversationId, userId, changes);
    const updated = (await this.conversationsRepository.getChatPreferences(conversationId, userId))!;
    this.realtimeGateway?.sendToUser(userId, { type: "conversation:preferences", conversationId, ...updated });
    return updated;
  }

  async getOrCreateDirectConversation(userId: string, otherUserId: string): Promise<Conversation> {
    if (userId === otherUserId) {
      throw new AppError("Cannot start a conversation with yourself", 400);
    }
    return this.conversationsRepository.getOrCreateDirectConversation(userId, otherUserId);
  }

  async listConversationsForUser(userId: string): Promise<ConversationSummary[]> {
    return this.conversationsRepository.listForUser(userId);
  }

  async getConversationById(conversationId: string, requestingUserId: string): Promise<Conversation | null> {
    const isMember = await this.conversationsRepository.isMember(conversationId, requestingUserId);
    if (!isMember) return null;
    return this.conversationsRepository.getById(conversationId);
  }

  async isMember(conversationId: string, userId: string): Promise<boolean> {
    return this.conversationsRepository.isMember(conversationId, userId);
  }
}
