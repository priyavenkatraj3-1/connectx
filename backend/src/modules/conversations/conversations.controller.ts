import type { Response } from "express";
import { AppError } from "../../middleware/errorHandler";
import type { AuthenticatedRequest } from "../../middleware/requireAuth";
import type { ConversationsService } from "./conversations.service";
import type { ChatPreferencesInput, CreateDirectConversationInput } from "./conversations.validation";

export class ConversationsController {
  constructor(private readonly conversationsService: ConversationsService) {}

  list = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const conversations = await this.conversationsService.listConversationsForUser(req.user!.userId);
    res.status(200).json({ conversations });
  };

  createDirect = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { userId: otherUserId } = req.body as CreateDirectConversationInput;
    const conversation = await this.conversationsService.getOrCreateDirectConversation(
      req.user!.userId,
      otherUserId
    );
    res.status(200).json({ conversation });
  };

  updatePreferences = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const preferences = await this.conversationsService.updateChatPreferences(
      req.params.conversationId as string,
      req.user!.userId,
      req.body as ChatPreferencesInput
    );
    res.status(200).json({ preferences });
  };

  getById = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const conversation = await this.conversationsService.getConversationById(
      req.params.conversationId as string,
      req.user!.userId
    );
    if (!conversation) {
      throw new AppError("Conversation not found", 404);
    }
    res.status(200).json({ conversation });
  };
}
