import type { MessageDTO } from "../modules/messages/messages.types";

/**
 * Server → client realtime events. Every event is a discriminated union on
 * `type` so the frontend can narrow payloads without casting.
 */
export type ServerEvent =
  | { type: "message:new"; conversationId: string; message: MessageDTO }
  | { type: "message:delivered"; conversationId: string; messageId: string; userId: string }
  | { type: "message:read"; conversationId: string; userId: string; upToMessageId: string }
  | { type: "conversation:updated"; conversationId: string }
  | { type: "error"; message: string };

/** Client → server events accepted over the WebSocket connection. */
export type ClientEvent =
  | { type: "ping" }
  | { type: "message:read"; conversationId: string; upToMessageId: string };
