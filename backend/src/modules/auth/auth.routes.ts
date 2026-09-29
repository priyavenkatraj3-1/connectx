import { Router } from "express";
import { authRateLimiter } from "../../middleware/rateLimiter";
import { validateBody } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import { AuthController } from "./auth.controller";
import type { AuthService } from "./auth.service";
import { loginSchema, refreshSchema, signupSchema } from "./auth.validation";

export function createAuthRouter(authService: AuthService): Router {
  const authController = new AuthController(authService);
  const router = Router();

  router.post("/signup", authRateLimiter, validateBody(signupSchema), asyncHandler(authController.signup));
  router.post("/login", authRateLimiter, validateBody(loginSchema), asyncHandler(authController.login));
  router.post("/refresh", validateBody(refreshSchema), asyncHandler(authController.refresh));
  router.post("/logout", asyncHandler(authController.logout));

  return router;
}
