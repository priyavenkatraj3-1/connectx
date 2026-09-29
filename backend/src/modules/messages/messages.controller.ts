import type { Response } from "express";
import type { AuthenticatedRequest } from "../../middleware/requireAuth";
import type { MessagesService } from "./messages.service";
import type { EditMessageInput, MarkReadInput, SendMessageInput } from "./messages.validation";

export class MessagesController {
  constructor(private readonly messagesService: MessagesService) {}

  list = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const conversationId = req.params.conversationId as string;
    const before = typeof req.query.before === "string" ? req.query.before : undefined;
    const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;

    const page = await this.messagesService.listMessages(conversationId, req.user!.userId, before, limit);
    res.status(200).json(page);
  };

  send = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const conversationId = req.params.conversationId as string;
    const { body, replyToMessageId, mentionedUserIds, attachmentId, clientMessageId } = req.body as SendMessageInput;

    const message = await this.messagesService.sendMessage({
      conversationId,
      senderId: req.user!.userId,
      body,
      replyToMessageId,
      mentionedUserIds,
      attachmentId,
      clientMessageId,
    });
    res.status(201).json({ message });
  };

  edit = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { body, mentionedUserIds } = req.body as EditMessageInput;
    const message = await this.messagesService.editMessage({
      conversationId: req.params.conversationId as string,
      messageId: req.params.messageId as string,
      userId: req.user!.userId,
      body,
      mentionedUserIds,
    });
    res.status(200).json({ message });
  };

  remove = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    await this.messagesService.deleteMessage({
      conversationId: req.params.conversationId as string,
      messageId: req.params.messageId as string,
      userId: req.user!.userId,
    });
    res.status(204).send();
  };

  markRead = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const conversationId = req.params.conversationId as string;
    const { upToMessageId } = req.body as MarkReadInput;

    await this.messagesService.markRead(conversationId, req.user!.userId, upToMessageId);
    res.status(204).send();
  };
}
