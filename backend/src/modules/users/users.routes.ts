import { Router, type RequestHandler } from "express";
import { requireAuth } from "../../middleware/requireAuth";
import { validateBody, validateParams, validateQuery } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import { UsersController } from "./users.controller";
import type { UsersService } from "./users.service";
import { searchUsersQuerySchema, updateProfileSchema, userParamsSchema } from "./users.validation";

/** Default when no limiter is supplied (e.g. unit tests building a bare router). */
const passThrough: RequestHandler = (_req, _res, next) => next();

export function createUsersRouter(usersService: UsersService, searchLimiter: RequestHandler = passThrough): Router {
  const controller = new UsersController(usersService);
  const router = Router();

  // Order matters: /search and /me must be registered before /:userId so
  // they aren't swallowed by the param route.
  router.get("/search", requireAuth, searchLimiter, validateQuery(searchUsersQuerySchema), asyncHandler(controller.search));
  router.get("/me", requireAuth, asyncHandler(controller.getMe));
  router.patch("/me", requireAuth, validateBody(updateProfileSchema), asyncHandler(controller.updateMe));
  router.get("/:userId", requireAuth, validateParams(userParamsSchema), asyncHandler(controller.getById));

  return router;
}
