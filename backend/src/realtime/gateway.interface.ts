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
}

/** Gateway that does nothing — used when no live WebSocket server is attached (e.g. plain HTTP-only tests). */
export const noopRealtimeGateway: RealtimeGateway = {
  sendToUser: () => undefined,
  isUserOnline: () => false,
};
