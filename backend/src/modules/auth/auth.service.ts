import { randomUUID } from "crypto";
import { AppError } from "../../middleware/errorHandler";
import type { UserRepository } from "./interfaces/user-repository.interface";
import { hashPassword, verifyPassword } from "./password.service";
import { signAccessToken, signRefreshToken } from "./token.service";
import type { LoginInput, SignupInput } from "./auth.validation";

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface AuthResult {
  user: {
    id: string;
    email: string;
    displayName: string;
  };
  tokens: AuthTokens;
}

export class AuthService {
  constructor(private readonly userRepository: UserRepository) {}

  async signup(input: SignupInput): Promise<AuthResult> {
    const existing = await this.userRepository.findByEmail(input.email);
    if (existing) {
      throw new AppError("An account with this email already exists", 409);
    }

    const passwordHash = await hashPassword(input.password);
    const user = await this.userRepository.create({
      email: input.email,
      passwordHash,
      displayName: input.displayName,
    });

    return this.buildAuthResult(user.id, user.email, user.displayName);
  }

  async login(input: LoginInput): Promise<AuthResult> {
    const user = await this.userRepository.findByEmail(input.email);
    if (!user) {
      throw new AppError("Invalid email or password", 401);
    }

    const passwordMatches = await verifyPassword(input.password, user.passwordHash);
    if (!passwordMatches) {
      throw new AppError("Invalid email or password", 401);
    }

    return this.buildAuthResult(user.id, user.email, user.displayName);
  }

  private buildAuthResult(userId: string, email: string, displayName: string): AuthResult {
    const sessionId = randomUUID();
    return {
      user: { id: userId, email, displayName },
      tokens: {
        accessToken: signAccessToken({ userId }),
        refreshToken: signRefreshToken({ userId, sessionId }),
      },
    };
  }
}
