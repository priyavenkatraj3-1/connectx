import type { Request, Response } from "express";
import { verifyAccessToken } from "./token.service";
import type { AuthService } from "./auth.service";
import type { LoginInput, RefreshInput, SignupInput } from "./auth.validation";

function userAgentOf(req: Request): string | undefined {
  const value = req.headers["user-agent"];
  return typeof value === "string" ? value : undefined;
}

export class AuthController {
  constructor(private readonly authService: AuthService) {}

  signup = async (req: Request, res: Response): Promise<void> => {
    const result = await this.authService.signup(req.body as SignupInput, { userAgent: userAgentOf(req) });
    res.status(201).json(result);
  };

  login = async (req: Request, res: Response): Promise<void> => {
    const result = await this.authService.login(req.body as LoginInput, { userAgent: userAgentOf(req) });
    res.status(200).json(result);
  };

  refresh = async (req: Request, res: Response): Promise<void> => {
    const result = await this.authService.refresh((req.body as RefreshInput).refreshToken);
    res.status(200).json(result);
  };

  /**
   * Ends the caller's session (Phase 6: sessions are server-side). Always
   * 204, so a client can log out even with an expired or missing token.
   */
  logout = async (req: Request, res: Response): Promise<void> => {
    const header = req.headers.authorization;
    if (header?.startsWith("Bearer ")) {
      try {
        const payload = verifyAccessToken(header.slice("Bearer ".length));
        await this.authService.logout(payload.userId, payload.sid);
      } catch {
        // Invalid/expired token: nothing server-side to end.
      }
    }
    res.status(204).send();
  };
}
