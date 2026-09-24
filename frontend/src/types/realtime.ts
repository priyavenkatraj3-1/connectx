import type { MessageDTO } from "./message";

/** Mirrors backend/src/realtime/events.ts — keep the two in sync. */
export type ServerEvent =
  | { type: "message:new"; conversationId: string; message: MessageDTO }
  | { type: "message:delivered"; conversationId: string; messageId: string; userId: string }
  | { type: "message:read"; conversationId: string; userId: string; upToMessageId: string }
  | { type: "conversation:updated"; conversationId: string }
  | { type: "error"; message: string };

export type ClientEvent =
  | { type: "ping" }
  | { type: "message:read"; conversationId: string; upToMessageId: string };
