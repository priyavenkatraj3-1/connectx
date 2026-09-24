import type { NextFunction, Response } from "express";
import type { AuthenticatedRequest } from "./requireAuth";
import { AppError } from "./errorHandler";

export interface MembershipChecker {
  isMember(conversationId: string, userId: string): Promise<boolean>;
}

/**
 * Authorization gate for conversation-scoped routes. Must run after
 * requireAuth. Reads `conversationId` from the route params and rejects
 * with 403 unless the authenticated user is an active member — this is
 * what stops one user from reading or writing another pair's messages.
 */
export function requireConversationMember(checker: MembershipChecker) {
  return async (req: AuthenticatedRequest, _res: Response, next: NextFunction): Promise<void> => {
    const conversationId = req.params.conversationId;
    if (!conversationId) {
      throw new AppError("conversationId is required", 400);
    }

    const isMember = await checker.isMember(conversationId, req.user!.userId);
    if (!isMember) {
      throw new AppError("You do not have access to this conversation", 403);
    }

    next();
  };
}
