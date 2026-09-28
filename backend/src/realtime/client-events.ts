import { z } from "zod";
import type { CallClientEvent, ClientEvent } from "./events";

/**
 * Runtime validation for client → server WebSocket events. Nothing a
 * client sends is trusted: identity comes from the authenticated socket
 * (never from the payload), and every field is shape- and size-checked
 * here before any handler sees it.
 */

const id = z.string().uuid();
/** Generous for real SDP (typically 2–10KB) while bounding abuse. */
const MAX_SDP_LENGTH = 64 * 1024;

const callId = z.object({ callId: id });

const callEventSchemas = {
  "call:ring": callId,
  "call:accept": callId,
  "call:decline": callId,
  "call:cancel": callId,
  "call:end": callId,
  "call:connected": callId,
  "call:offer": z.object({ callId: id, toUserId: id, sdp: z.string().min(1).max(MAX_SDP_LENGTH) }),
  "call:answer": z.object({ callId: id, toUserId: id, sdp: z.string().min(1).max(MAX_SDP_LENGTH) }),
  "call:ice_candidate": z.object({
    callId: id,
    toUserId: id,
    candidate: z
      .object({
        // An empty candidate string is the standard "end of candidates" marker.
        candidate: z.string().max(2048),
        sdpMid: z.string().max(64).nullable().optional(),
        sdpMLineIndex: z.number().int().min(0).max(64).nullable().optional(),
        usernameFragment: z.string().max(256).nullable().optional(),
      })
      .strict(),
  }),
  "call:failed": z.object({ callId: id, reason: z.enum(["connection_failed", "media_error"]) }),
  "call:media_state": z.object({ callId: id, audioEnabled: z.boolean(), videoEnabled: z.boolean() }),
} as const;

type CallEventType = keyof typeof callEventSchemas;

const messageReadSchema = z.object({ conversationId: id, upToMessageId: id });

export type ParsedClientEvent =
  | { ok: true; event: ClientEvent }
  /** Recognized type, invalid payload. `callId` is echoed back (if it parsed) so the client can correlate the error. */
  | { ok: false; kind: "invalid"; type: string; callId: string | null; message: string }
  /** Not JSON, or an event type this server doesn't handle — ignored, as before Phase 4. */
  | { ok: false; kind: "ignored" };

function isCallEventType(type: string): type is CallEventType {
  return Object.prototype.hasOwnProperty.call(callEventSchemas, type);
}

export function parseClientEvent(raw: string): ParsedClientEvent {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, kind: "ignored" };
  }
  if (!data || typeof data !== "object" || typeof (data as { type?: unknown }).type !== "string") {
    return { ok: false, kind: "ignored" };
  }
  const { type, ...payload } = data as { type: string } & Record<string, unknown>;

  if (type === "ping") return { ok: true, event: { type: "ping" } };

  if (type === "message:read") {
    const result = messageReadSchema.safeParse(payload);
    if (!result.success) return { ok: false, kind: "ignored" };
    return { ok: true, event: { type, ...result.data } };
  }

  if (isCallEventType(type)) {
    const result = callEventSchemas[type].safeParse(payload);
    if (!result.success) {
      const echoedCallId = typeof payload.callId === "string" && id.safeParse(payload.callId).success ? payload.callId : null;
      return { ok: false, kind: "invalid", type, callId: echoedCallId, message: `Malformed ${type} event` };
    }
    return { ok: true, event: { type, ...result.data } as CallClientEvent };
  }

  return { ok: false, kind: "ignored" };
}

export function isCallClientEvent(event: ClientEvent): event is CallClientEvent {
  return event.type.startsWith("call:");
}
