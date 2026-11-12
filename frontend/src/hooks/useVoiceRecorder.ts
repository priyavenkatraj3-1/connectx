import { useCallback, useEffect, useRef, useState } from "react";
import { friendlyMediaError } from "../lib/webrtc/mediaErrors";
import {
  baseMimeType,
  browserRecordingEnvironment,
  checkRecordingSupport,
  extensionForRecordedType,
  MAX_RECORDING_SECONDS,
  MIN_RECORDING_MS,
  pickRecordingMimeType,
  RECORDING_BITS_PER_SECOND,
  recordingFileName,
  TOO_SHORT_MESSAGE,
  UNSUPPORTED_FORMAT_MESSAGE,
} from "../lib/media/voiceRecording";

export type VoiceRecorderStatus = "idle" | "requesting" | "recording";

export interface VoiceRecorderCallbacks {
  /** A finished recording, named and typed so the backend stores it as audio. */
  onRecorded(file: File): void;
  /** A user-facing message (permission denied, unsupported browser/format, too short, recorder failure). */
  onError(message: string): void;
  /** Informational message (e.g. stopped at the length limit). */
  onNotice?(message: string): void;
}

interface Session {
  stream: MediaStream;
  recorder: MediaRecorder;
  chunks: Blob[];
  startedAt: number;
  timer: ReturnType<typeof setInterval> | undefined;
  /** True when the result must be thrown away (cancel, unmount, recorder error). */
  discard: boolean;
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

/**
 * Browser voice recording with MediaRecorder. The microphone is requested
 * only when `start()` is called (from a click), and its tracks are stopped
 * on every way out: stop, cancel, recorder error, failed start, and unmount.
 * A permission prompt that resolves after cancel/unmount has its stream
 * stopped immediately and is otherwise ignored.
 */
export function useVoiceRecorder(callbacks: VoiceRecorderCallbacks) {
  const [status, setStatus] = useState<VoiceRecorderStatus>("idle");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const session = useRef<Session | null>(null);
  /** Bumped by cancel/unmount so an in-flight getUserMedia knows it's no longer wanted. */
  const generation = useRef(0);
  const mounted = useRef(true);
  // Always call the latest callbacks (they close over the composer's current conversation and token).
  const latest = useRef(callbacks);
  latest.current = callbacks;

  const end = useCallback((current: Session) => {
    if (current.timer !== undefined) clearInterval(current.timer);
    stopTracks(current.stream);
    if (session.current === current) session.current = null;
  }, []);

  const finish = useCallback(
    (current: Session) => {
      end(current);
      if (mounted.current) {
        setStatus("idle");
        setElapsedSeconds(0);
      }
      if (current.discard || !mounted.current) return;

      const recordedType = current.recorder.mimeType || current.chunks[0]?.type || "";
      const extension = extensionForRecordedType(recordedType);
      if (!extension) {
        latest.current.onError(UNSUPPORTED_FORMAT_MESSAGE);
        return;
      }
      const type = baseMimeType(recordedType);
      const blob = new Blob(current.chunks, { type });
      if (blob.size === 0 || Date.now() - current.startedAt < MIN_RECORDING_MS) {
        latest.current.onError(TOO_SHORT_MESSAGE);
        return;
      }
      latest.current.onRecorded(new File([blob], recordingFileName(extension), { type }));
    },
    [end]
  );

  const stop = useCallback(() => {
    const current = session.current;
    if (!current) return;
    if (current.timer !== undefined) clearInterval(current.timer);
    current.timer = undefined;
    if (current.recorder.state !== "inactive") {
      try {
        // The recorder flushes its last chunk and fires `stop`, which builds the file (finish).
        current.recorder.stop();
      } catch {
        // A recorder that can't stop won't report back: release the mic and say so, rather than leave it on.
        current.discard = true;
        end(current);
        if (mounted.current) {
          setStatus("idle");
          setElapsedSeconds(0);
          latest.current.onError("Recording stopped unexpectedly. Please try again.");
        }
        return;
      }
      stopTracks(current.stream);
    } else {
      finish(current);
    }
  }, [finish, end]);

  const cancel = useCallback(() => {
    generation.current += 1;
    const current = session.current;
    if (current) {
      current.discard = true;
      if (current.recorder.state !== "inactive") {
        try {
          current.recorder.stop();
        } catch {
          // Already stopping; the tracks are stopped below either way.
        }
      }
      end(current);
    }
    if (mounted.current) {
      setStatus("idle");
      setElapsedSeconds(0);
    }
  }, [end]);

  const start = useCallback(async () => {
    if (session.current || status !== "idle") return;
    const env = browserRecordingEnvironment();
    const unsupported = checkRecordingSupport(env);
    if (unsupported) {
      latest.current.onError(unsupported);
      return;
    }

    const attempt = ++generation.current;
    setStatus("requesting");
    let stream: MediaStream;
    try {
      stream = await env.mediaDevices!.getUserMedia({ audio: true });
    } catch (err) {
      if (attempt === generation.current && mounted.current) {
        setStatus("idle");
        latest.current.onError(friendlyMediaError(err, "voice").message);
      }
      return;
    }
    if (attempt !== generation.current || !mounted.current) {
      stopTracks(stream); // cancelled or unmounted while the permission prompt was open
      return;
    }

    const Recorder = env.MediaRecorder as unknown as typeof MediaRecorder;
    const mimeType = pickRecordingMimeType(Recorder.isTypeSupported?.bind(Recorder));
    let recorder: MediaRecorder;
    try {
      recorder = new Recorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: RECORDING_BITS_PER_SECOND });
    } catch {
      stopTracks(stream);
      setStatus("idle");
      latest.current.onError(UNSUPPORTED_FORMAT_MESSAGE);
      return;
    }

    const current: Session = { stream, recorder, chunks: [], startedAt: Date.now(), timer: undefined, discard: false };
    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data && event.data.size > 0) current.chunks.push(event.data);
    };
    recorder.onstop = () => finish(current);
    recorder.onerror = () => {
      if (current.discard) return;
      current.discard = true;
      end(current);
      if (mounted.current) {
        setStatus("idle");
        setElapsedSeconds(0);
        latest.current.onError("Recording stopped unexpectedly. Please try again.");
      }
    };

    try {
      recorder.start(1000); // 1 s chunks: a crash mid-recording loses at most a second
    } catch {
      stopTracks(stream);
      setStatus("idle");
      latest.current.onError(UNSUPPORTED_FORMAT_MESSAGE);
      return;
    }

    session.current = current;
    setElapsedSeconds(0);
    setStatus("recording");
    current.timer = setInterval(() => {
      const seconds = Math.floor((Date.now() - current.startedAt) / 1000);
      setElapsedSeconds(seconds);
      if (seconds >= MAX_RECORDING_SECONDS && session.current === current) {
        latest.current.onNotice?.(`Recording stopped at the ${MAX_RECORDING_SECONDS / 60}-minute limit.`);
        stop();
      }
    }, 250);
  }, [status, finish, end, stop]);

  // Unmount: discard any recording and release the microphone.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
      const current = session.current;
      if (current) {
        current.discard = true;
        if (current.recorder.state !== "inactive") {
          try {
            current.recorder.stop();
          } catch {
            // ignore
          }
        }
        end(current);
      }
    };
  }, [end]);

  return { status, elapsedSeconds, start, stop, cancel };
}
