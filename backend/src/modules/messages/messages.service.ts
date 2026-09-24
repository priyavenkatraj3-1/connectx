import type { ConversationsRepository } from "../conversations/conversations.repository";
import type { RealtimeGateway } from "../../realtime/gateway.interface";
import type { MessageDTO, MessagePage } from "./messages.types";
import type { MessagesRepository } from "./messages.repository";

export class MessagesService {
  constructor(
    private readonly messagesRepository: MessagesRepository,
    private readonly conversationsRepository: ConversationsRepository,
    private readonly realtimeGateway: RealtimeGateway
  ) {}

  async sendMessage(input: { conversationId: string; senderId: string; body: string }): Promise<MessageDTO> {
    const message = await this.messagesRepository.insert(input);
    await this.conversationsRepository.touchUpdatedAt(input.conversationId);

    const memberIds = await this.conversationsRepository.getAllMemberIds(input.conversationId);
    const recipientIds = memberIds.filter((id) => id !== input.senderId);

    let deliveredDto = message;
    for (const recipientId of recipientIds) {
      if (this.realtimeGateway.isUserOnline(recipientId)) {
        await this.messagesRepository.markDelivered(message.id, recipientId);
        deliveredDto = { ...message, status: "delivered" };
        this.realtimeGateway.sendToUser(input.senderId, {
          type: "message:delivered",
          conversationId: input.conversationId,
          messageId: message.id,
          userId: recipientId,
        });
      }

      this.realtimeGateway.sendToUser(recipientId, {
        type: "message:new",
        conversationId: input.conversationId,
        message,
      });
    }

    // Echo to the sender's own other connections (multi-tab/multi-device sync).
    this.realtimeGateway.sendToUser(input.senderId, {
      type: "message:new",
      conversationId: input.conversationId,
      message: deliveredDto,
    });

    return deliveredDto;
  }

  async listMessages(
    conversationId: string,
    _requestingUserId: string,
    before?: string,
    limit?: number
  ): Promise<MessagePage> {
    return this.messagesRepository.listByConversation(conversationId, before, limit);
  }

  async markRead(conversationId: string, userId: string, upToMessageId: string): Promise<void> {
    await this.conversationsRepository.updateLastRead(conversationId, userId, upToMessageId);
    await this.messagesRepository.markReadUpTo(conversationId, userId, upToMessageId);

    const otherUserId = await this.conversationsRepository.getOtherMemberId(conversationId, userId);
    if (otherUserId) {
      this.realtimeGateway.sendToUser(otherUserId, {
        type: "message:read",
        conversationId,
        userId,
        upToMessageId,
      });
    }
  }
}
