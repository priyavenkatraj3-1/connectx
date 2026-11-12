import { AppError } from "../../middleware/errorHandler";
import type { ConversationsService } from "../conversations/conversations.service";
import type { MessagesService } from "../messages/messages.service";
import type { MessageDTO } from "../messages/messages.types";
import type { StatusesRepository } from "./statuses.repository";

/** Longest status text kept on a reply (the column allows 120). */
const PREVIEW_LENGTH = 100;

/**
 * Replying to a status = a direct message to its owner, through the normal
 * messaging pipeline (membership, receipts, realtime, offline sync), with a
 * snapshot of which status it answered. Only someone allowed to see the
 * status right now may reply (404 otherwise — same as viewing, so the
 * status's existence isn't confirmed); you can't reply to your own.
 */
export class StatusRepliesService {
  constructor(
    private readonly statusesRepository: StatusesRepository,
    private readonly conversationsService: ConversationsService,
    private readonly messagesService: MessagesService
  ) {}

  async reply(statusId: string, senderId: string, body: string): Promise<{ conversationId: string; message: MessageDTO }> {
    if (!(await this.statusesRepository.isVisibleTo(statusId, senderId))) throw new AppError("Status not found", 404);
    const status = await this.statusesRepository.findById(statusId);
    if (!status) throw new AppError("Status not found", 404);
    if (status.userId === senderId) throw new AppError("You can't reply to your own status", 400);

    const conversation = await this.conversationsService.getOrCreateDirectConversation(senderId, status.userId);
    const preview = status.text ? (status.text.length > PREVIEW_LENGTH ? `${status.text.slice(0, PREVIEW_LENGTH - 1)}…` : status.text) : null;
    const message = await this.messagesService.sendMessage({
      conversationId: conversation.id,
      senderId,
      body,
      statusReply: { statusId: status.id, type: status.type, preview },
    });
    return { conversationId: conversation.id, message };
  }
}
