import { AppError } from "../../middleware/errorHandler";
import type { Conversation, ConversationService } from "./conversation.interface";
import type { ConversationsRepository } from "./conversations.repository";
import type { ConversationSummary } from "./conversations.types";

export class ConversationsService implements ConversationService {
  constructor(private readonly conversationsRepository: ConversationsRepository) {}

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
