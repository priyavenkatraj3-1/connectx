import type { Request, Response } from "express";
import type { AuthService } from "./auth.service";
import type { LoginInput, SignupInput } from "./auth.validation";

export class AuthController {
  constructor(private readonly authService: AuthService) {}

  signup = async (req: Request, res: Response): Promise<void> => {
    const result = await this.authService.signup(req.body as SignupInput);
    res.status(201).json(result);
  };

  login = async (req: Request, res: Response): Promise<void> => {
    const result = await this.authService.login(req.body as LoginInput);
    res.status(200).json(result);
  };

  logout = async (_req: Request, res: Response): Promise<void> => {
    // Phase 1: stateless JWT access tokens with no server-side session store.
    // The client discards its tokens; refresh-token revocation will be added
    // once the `sessions` table (see docs/database.md) is backed by a real DB.
    res.status(204).send();
  };
}
