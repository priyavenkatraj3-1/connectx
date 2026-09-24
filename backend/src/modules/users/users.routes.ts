import { Router } from "express";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/requireAuth";
import { asyncHandler } from "../../utils/asyncHandler";

export const usersRouter = Router();

/**
 * Returns the identity of the currently authenticated user. This is a thin
 * Phase 1 placeholder demonstrating the protected-route pattern; full
 * profile retrieval (bio, avatar, status, privacy settings) lands once the
 * `user_profiles` table (see docs/database.md) is backed by a real database.
 */
usersRouter.get(
  "/me",
  requireAuth,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    res.status(200).json({ userId: req.user?.userId });
  })
);
