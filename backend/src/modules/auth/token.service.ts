import { randomUUID } from "crypto";
import jwt from "jsonwebtoken";
import { env } from "../../config/env";

export interface AccessTokenPayload {
  userId: string;
  /** Session ID (Phase 6). Every token issued by login/signup/refresh carries one; see SessionsService. */
  sid?: string;
}

export interface RefreshTokenPayload {
  userId: string;
  sessionId: string;
}

export function signAccessToken(payload: AccessTokenPayload): string {
  const options: jwt.SignOptions = { expiresIn: env.jwt.accessExpiry as jwt.SignOptions["expiresIn"] };
  return jwt.sign(payload, env.jwt.accessSecret, options);
}

export function signRefreshToken(payload: RefreshTokenPayload): string {
  // A unique jti makes every rotated refresh token distinct, even within the same second.
  const options: jwt.SignOptions = { expiresIn: env.jwt.refreshExpiry as jwt.SignOptions["expiresIn"], jwtid: randomUUID() };
  return jwt.sign({ userId: payload.userId, sessionId: payload.sessionId }, env.jwt.refreshSecret, options);
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, env.jwt.accessSecret) as AccessTokenPayload;
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  return jwt.verify(token, env.jwt.refreshSecret) as RefreshTokenPayload;
}
