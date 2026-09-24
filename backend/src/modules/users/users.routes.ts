import { Router } from "express";
import { requireAuth } from "../../middleware/requireAuth";
import { validateBody, validateQuery } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import { UsersController } from "./users.controller";
import type { UsersService } from "./users.service";
import { searchUsersQuerySchema, updateProfileSchema } from "./users.validation";

export function createUsersRouter(usersService: UsersService): Router {
  const controller = new UsersController(usersService);
  const router = Router();

  // Order matters: /search and /me must be registered before /:userId so
  // they aren't swallowed by the param route.
  router.get("/search", requireAuth, validateQuery(searchUsersQuerySchema), asyncHandler(controller.search));
  router.get("/me", requireAuth, asyncHandler(controller.getMe));
  router.patch("/me", requireAuth, validateBody(updateProfileSchema), asyncHandler(controller.updateMe));
  router.get("/:userId", requireAuth, asyncHandler(controller.getById));

  return router;
}
