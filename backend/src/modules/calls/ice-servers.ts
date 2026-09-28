import { createHmac } from "crypto";
import type { IceServerConfig } from "./calls.types";

export interface IceServerSettings {
  stunUrls: string[];
  turnUrls: string[];
  turnUsername?: string;
  turnCredential?: string;
  turnSecret?: string;
  turnCredentialTtlSeconds: number;
}

/**
 * Builds the RTCIceServer list a call client should use.
 *
 * TURN credentials, when configured, come in two flavours:
 *   * `turnSecret` (preferred): time-limited credentials per the TURN REST
 *     API convention implemented by coturn's `use-auth-secret` —
 *     username = "<expiry-unix-seconds>:<userId>",
 *     credential = base64(HMAC-SHA1(secret, username)).
 *     The secret itself never leaves the server, and leaked credentials
 *     stop working after the TTL.
 *   * static `turnUsername`/`turnCredential`: simple, but every client
 *     receives the same long-lived credential.
 *
 * Nothing here is hard-coded: with no configuration the list is empty,
 * which still works for calls between browsers on the same machine/LAN.
 */
export function buildIceServers(settings: IceServerSettings, userId: string, now: Date = new Date()): IceServerConfig[] {
  const servers: IceServerConfig[] = [];

  if (settings.stunUrls.length > 0) {
    servers.push({ urls: settings.stunUrls });
  }

  if (settings.turnUrls.length > 0) {
    if (settings.turnSecret) {
      const expiresAt = Math.floor(now.getTime() / 1000) + settings.turnCredentialTtlSeconds;
      const username = `${expiresAt}:${userId}`;
      const credential = createHmac("sha1", settings.turnSecret).update(username).digest("base64");
      servers.push({ urls: settings.turnUrls, username, credential });
    } else if (settings.turnUsername && settings.turnCredential) {
      servers.push({ urls: settings.turnUrls, username: settings.turnUsername, credential: settings.turnCredential });
    }
    // TURN URLs without any credentials are unusable (TURN always authenticates), so they're omitted.
  }

  return servers;
}
