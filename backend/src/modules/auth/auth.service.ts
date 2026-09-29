import { AppError } from "../../middleware/errorHandler";
import type { NotificationsService } from "../notifications/notifications.service";
import type { DeviceInfo, SessionsService } from "../sessions/sessions.service";
import type { UserRepository } from "./interfaces/user-repository.interface";
import { hashPassword, verifyPassword } from "./password.service";
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
  /** The server-side session this sign-in created (Phase 6) — lets a client recognize itself in the device list. */
  session: { id: string };
}

export class AuthService {
  constructor(
    private readonly userRepository: UserRepository,
    private readonly sessions: SessionsService,
    private readonly notifications?: NotificationsService
  ) {}

  async signup(input: SignupInput, device: DeviceInfo = {}): Promise<AuthResult> {
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

    return this.buildAuthResult(user.id, user.email, user.displayName, { ...device, ...deviceFromInput(input) });
  }

  async login(input: LoginInput, device: DeviceInfo = {}): Promise<AuthResult> {
    const user = await this.userRepository.findByEmail(input.email);
    if (!user) {
      throw new AppError("Invalid email or password", 401);
    }

    const passwordMatches = await verifyPassword(input.password, user.passwordHash);
    if (!passwordMatches) {
      throw new AppError("Invalid email or password", 401);
    }

    const result = await this.buildAuthResult(user.id, user.email, user.displayName, { ...device, ...deviceFromInput(input) });
    // Security activity: tell the user's other devices about the new sign-in.
    const sessions = await this.sessions.list(user.id, result.session.id);
    const current = sessions.find((session) => session.current);
    if (sessions.length > 1 && current) {
      await this.notifications
        ?.notify({
          userId: user.id,
          type: "session_new",
          title: "New sign-in to your account",
          body: `${current.deviceName} signed in. If this wasn't you, sign it out in Settings → Devices.`,
          payload: { sessionId: current.id },
        })
        .catch(() => undefined);
    }
    return result;
  }

  async refresh(refreshToken: string): Promise<{ tokens: AuthTokens; session: { id: string } }> {
    const issued = await this.sessions.refresh(refreshToken);
    return { tokens: { accessToken: issued.accessToken, refreshToken: issued.refreshToken }, session: { id: issued.sessionId } };
  }

  /** Ends the session the access token belongs to. Idempotent. */
  async logout(userId: string, sessionId: string | undefined): Promise<void> {
    if (sessionId) await this.sessions.revoke(userId, sessionId).catch(() => undefined);
  }

  private async buildAuthResult(userId: string, email: string, displayName: string, device: DeviceInfo): Promise<AuthResult> {
    const issued = await this.sessions.createSession(userId, device);
    return {
      user: { id: userId, email, displayName },
      tokens: { accessToken: issued.accessToken, refreshToken: issued.refreshToken },
      session: { id: issued.sessionId },
    };
  }
}

function deviceFromInput(input: { device?: { name?: string; platform?: DeviceInfo["platform"] } }): DeviceInfo {
  const info: DeviceInfo = {};
  if (input.device?.name) info.deviceName = input.device.name;
  if (input.device?.platform) info.platform = input.device.platform;
  return info;
}
