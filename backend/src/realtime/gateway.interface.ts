import type { ServerEvent } from "./events";

/**
 * What message/conversation services depend on to push realtime updates.
 * The live WebSocket server (ws.server.ts) implements this; tests that
 * don't need a real socket can inject a no-op or recording fake instead —
 * see backend/tests/helpers/fakeRealtimeGateway.ts.
 */
export interface RealtimeGateway {
  sendToUser(userId: string, event: ServerEvent): void;
  isUserOnline(userId: string): boolean;
  /**
   * Sends to one specific connection (browser tab/device) of a user —
   * used for call signaling, which must reach only the device that
   * actually joined the call. Returns false if that connection is gone.
   */
  sendToConnection(userId: string, connectionId: string, event: ServerEvent): boolean;
  /** True if `connectionId` is a currently open connection belonging to `userId`. */
  hasConnection(userId: string, connectionId: string): boolean;
  /**
   * Closes every open connection authenticated with `sessionId` (Phase 6
   * session revocation). Optional so test fakes needn't implement it.
   */
  disconnectSession?(userId: string, sessionId: string): void;
}

/** Gateway that does nothing — used when no live WebSocket server is attached (e.g. plain HTTP-only tests). */
export const noopRealtimeGateway: RealtimeGateway = {
  sendToUser: () => undefined,
  isUserOnline: () => false,
  sendToConnection: () => false,
  hasConnection: () => false,
  disconnectSession: () => undefined,
};
