/**
 * In-chat voice recording helpers: which MediaRecorder format to ask for,
 * which file extension the result must carry, and whether this browser can
 * record at all. Pure functions, so they're unit-tested directly.
 *
 * Why the extension matters: the backend decides an upload's type from its
 * extension + bytes (backend/src/modules/media/file-validation.ts). A WebM
 * recording named ".webm" is stored as *video/webm* (a video), so it would
 * lose the audio player's voice features (transcription, translation). WebM
 * audio must be named ".weba" (stored as audio/webm), Ogg ".ogg", MP4 ".m4a".
 */

/** Preferred recording formats, best first: Chrome/Edge (WebM/Opus), Firefox (Ogg/Opus), Safari (MP4/AAC). */
export const RECORDING_MIME_PREFERENCES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/ogg", "audio/mp4"] as const;

/** Recorded base MIME type → extension the backend validates as audio. */
const EXTENSION_BY_BASE_TYPE: Readonly<Record<string, string>> = {
  "audio/webm": "weba",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
};

/**
 * Longest recording, in seconds. At RECORDING_BITS_PER_SECOND this is about
 * 2.4 MB — far below the 25 MB upload limit and Gemini's 14 MiB
 * transcription limit, so a recording that can be sent can also be
 * transcribed and translated.
 */
export const MAX_RECORDING_SECONDS = 10 * 60;
/** Opus/AAC speech is clear at 32 kbps and keeps files small. Browsers may round it. */
export const RECORDING_BITS_PER_SECOND = 32_000;
/** Shorter recordings are almost always accidental taps. */
export const MIN_RECORDING_MS = 500;

export const UNSUPPORTED_RECORDING_MESSAGE =
  "Voice recording isn't supported in this browser. Use an up-to-date Chrome, Edge, Firefox or Safari, on https:// or localhost.";
export const UNSUPPORTED_FORMAT_MESSAGE = "This browser records audio in a format ConnectX can't send. Try Chrome, Edge, Firefox or Safari.";
export const TOO_SHORT_MESSAGE = "That recording was too short. Hold on a little longer before stopping.";

/** The base type ("audio/webm") of a MIME type with parameters ("audio/webm;codecs=opus"). */
export function baseMimeType(mimeType: string): string {
  return mimeType.split(";")[0]!.trim().toLowerCase();
}

/** First preferred format the browser can record, or null (then the browser's default is checked after recording). */
export function pickRecordingMimeType(isTypeSupported: ((type: string) => boolean) | undefined): string | null {
  if (typeof isTypeSupported !== "function") return null;
  return RECORDING_MIME_PREFERENCES.find((type) => isTypeSupported(type)) ?? null;
}

/** Extension for what the recorder actually produced (its `mimeType`), or null if ConnectX can't send it. */
export function extensionForRecordedType(actualMimeType: string): string | null {
  return EXTENSION_BY_BASE_TYPE[baseMimeType(actualMimeType)] ?? null;
}

/** A neutral, sortable file name (the user's name never appears). */
export function recordingFileName(extension: string, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `voice-message-${stamp}.${extension}`;
}

/** "m:ss" for a duration in whole seconds. */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export interface RecordingEnvironment {
  mediaDevices?: Pick<MediaDevices, "getUserMedia">;
  MediaRecorder?: { isTypeSupported?(type: string): boolean };
  isSecureContext?: boolean;
}

/** Null when recording can be attempted, else a message saying why it can't. */
export function checkRecordingSupport(env: RecordingEnvironment): string | null {
  if (env.isSecureContext === false) return UNSUPPORTED_RECORDING_MESSAGE;
  if (!env.mediaDevices || typeof env.mediaDevices.getUserMedia !== "function") return UNSUPPORTED_RECORDING_MESSAGE;
  if (typeof env.MediaRecorder !== "function") return UNSUPPORTED_RECORDING_MESSAGE;
  return null;
}

/** The browser's recording APIs (read at call time, so tests can install fakes). */
export function browserRecordingEnvironment(): RecordingEnvironment {
  return {
    mediaDevices: typeof navigator !== "undefined" ? navigator.mediaDevices : undefined,
    MediaRecorder: typeof MediaRecorder !== "undefined" ? MediaRecorder : undefined,
    isSecureContext: typeof window !== "undefined" ? window.isSecureContext : undefined,
  };
}
