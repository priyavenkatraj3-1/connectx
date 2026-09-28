import type { CallMedia } from "../../types/call";

/**
 * Turns browser media/WebRTC failures into messages a person can act on.
 * Raw DOMException text ("NotAllowedError: Permission denied") is never
 * shown to users.
 */
export class CallMediaError extends Error {
  constructor(
    message: string,
    /** The DOMException name (or our own code) — for logic, never for display. */
    public readonly code: string
  ) {
    super(message);
  }
}

function deviceWords(media: CallMedia): string {
  return media === "video" ? "camera and microphone" : "microphone";
}

export function friendlyMediaError(err: unknown, media: CallMedia): CallMediaError {
  if (err instanceof CallMediaError) return err;
  const name = err && typeof err === "object" && "name" in err ? String((err as { name: unknown }).name) : "";
  const devices = deviceWords(media);

  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      return new CallMediaError(
        `ConnectX needs permission to use your ${devices}. Allow access in your browser's site settings, then try again.`,
        "permission_denied"
      );
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
      return new CallMediaError(`No ${devices} was found. Connect one and try again.`, "device_not_found");
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return new CallMediaError(
        `Your ${devices} couldn't be started — another app may be using it. Close that app and try again.`,
        "device_busy"
      );
    default:
      return new CallMediaError(`Couldn't access your ${devices}. Check your browser settings and try again.`, "unknown");
  }
}

export const UNSUPPORTED_BROWSER_MESSAGE =
  "Calls aren't supported here. Use an up-to-date Chrome, Edge, Firefox or Safari, on https:// or localhost.";

/** WebRTC + getUserMedia need a modern browser *and* a secure context (https or localhost). */
export function checkCallSupport(env: { mediaDevices?: MediaDevices; hasPeerConnection: boolean }): string | null {
  if (!env.mediaDevices || typeof env.mediaDevices.getUserMedia !== "function" || !env.hasPeerConnection) {
    return UNSUPPORTED_BROWSER_MESSAGE;
  }
  return null;
}

export interface AcquiredMedia {
  stream: MediaStream;
  /** True when a video call had to fall back to audio only (camera missing/busy). */
  cameraUnavailable: boolean;
}

/**
 * Gets the local stream for a call. For video calls, a missing or busy
 * camera degrades to an audio-only stream (with a notice) instead of
 * failing the whole call; a missing microphone or denied permission fails.
 */
export async function acquireLocalMedia(mediaDevices: MediaDevices, media: CallMedia): Promise<AcquiredMedia> {
  try {
    const stream = await mediaDevices.getUserMedia({ audio: true, video: media === "video" });
    return { stream, cameraUnavailable: false };
  } catch (err) {
    const friendly = friendlyMediaError(err, media);
    if (media === "video" && (friendly.code === "device_not_found" || friendly.code === "device_busy")) {
      try {
        const stream = await mediaDevices.getUserMedia({ audio: true, video: false });
        return { stream, cameraUnavailable: true };
      } catch (audioErr) {
        throw friendlyMediaError(audioErr, "voice");
      }
    }
    throw friendly;
  }
}
