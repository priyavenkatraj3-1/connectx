import { Router } from "express";
import { authRateLimiter } from "../../middleware/rateLimiter";
import { validateBody } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { loginSchema, signupSchema } from "./auth.validation";
import { InMemoryUserRepository } from "./in-memory-user.repository";

// Phase 1: single process-local repository instance. A later phase will
// replace this with dependency injection wired to a real database pool.
const userRepository = new InMemoryUserRepository();
const authService = new AuthService(userRepository);
const authController = new AuthController(authService);

export const authRouter = Router();

authRouter.post("/signup", authRateLimiter, validateBody(signupSchema), asyncHandler(authController.signup));
authRouter.post("/login", authRateLimiter, validateBody(loginSchema), asyncHandler(authController.login));
authRouter.post("/logout", asyncHandler(authController.logout));
