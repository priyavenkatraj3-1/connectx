import express, { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { AppError } from "../../middleware/errorHandler";
import { requireAuth } from "../../middleware/requireAuth";
import { validateBody, validateParams, validateQuery } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import { UsersController } from "./users.controller";
import { AVATAR_MAX_BYTES, type UsersService } from "./users.service";
import { avatarParamsSchema, searchUsersQuerySchema, updateProfileSchema, userParamsSchema } from "./users.validation";

/** Default when no limiter is supplied (e.g. unit tests building a bare router). */
const passThrough: RequestHandler = (_req, _res, next) => next();

export function createUsersRouter(
  usersService: UsersService,
  searchLimiter: RequestHandler = passThrough,
  uploadLimiter: RequestHandler = passThrough
): Router {
  const controller = new UsersController(usersService);
  const router = Router();

  // Order matters: /search and /me must be registered before /:userId so
  // they aren't swallowed by the param route.
  router.get("/search", requireAuth, searchLimiter, validateQuery(searchUsersQuerySchema), asyncHandler(controller.search));
  router.get("/me", requireAuth, asyncHandler(controller.getMe));
  router.patch("/me", requireAuth, validateBody(updateProfileSchema), asyncHandler(controller.updateMe));

  // Profile picture: the raw image bytes as the body (any Content-Type; the type is read from the bytes).
  const avatarBody = express.raw({ type: () => true, limit: AVATAR_MAX_BYTES });
  const avatarTooLarge = (err: unknown, _req: Request, _res: Response, next: NextFunction): void => {
    if (err && typeof err === "object" && "type" in err && (err as { type: string }).type === "entity.too.large") {
      next(new AppError(`Profile pictures can be at most ${AVATAR_MAX_BYTES / (1024 * 1024)}MB`, 413));
      return;
    }
    next(err);
  };
  router.put("/me/avatar", requireAuth, uploadLimiter, avatarBody, avatarTooLarge, asyncHandler(controller.uploadAvatar));
  router.delete("/me/avatar", requireAuth, asyncHandler(controller.removeAvatar));
  // No requireAuth: an <img> can't send a token. Only a user's current picture is served (see UsersService.readAvatar).
  router.get("/:userId/avatar/:avatarId", validateParams(avatarParamsSchema), asyncHandler(controller.getAvatar));
  router.get("/:userId", requireAuth, validateParams(userParamsSchema), asyncHandler(controller.getById));

  return router;
}
