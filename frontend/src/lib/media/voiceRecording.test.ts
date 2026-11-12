import { describe, expect, it } from "vitest";
import { ACCEPTED_FILE_EXTENSIONS, guessKind, MAX_UPLOAD_BYTES } from "../../services/mediaService";
import {
  baseMimeType,
  checkRecordingSupport,
  extensionForRecordedType,
  formatDuration,
  MAX_RECORDING_SECONDS,
  pickRecordingMimeType,
  RECORDING_BITS_PER_SECOND,
  recordingFileName,
  UNSUPPORTED_RECORDING_MESSAGE,
} from "./voiceRecording";

describe("voice recording formats", () => {
  it("prefers WebM/Opus, then Ogg/Opus, then MP4", () => {
    expect(pickRecordingMimeType((t) => t.startsWith("audio/webm"))).toBe("audio/webm;codecs=opus");
    expect(pickRecordingMimeType((t) => t.startsWith("audio/ogg"))).toBe("audio/ogg;codecs=opus");
    expect(pickRecordingMimeType((t) => t === "audio/mp4")).toBe("audio/mp4");
    expect(pickRecordingMimeType(() => false)).toBeNull();
    expect(pickRecordingMimeType(undefined)).toBeNull();
  });

  it("names WebM audio .weba (never .webm, which the server stores as video), Ogg .ogg and MP4 .m4a", () => {
    expect(extensionForRecordedType("audio/webm;codecs=opus")).toBe("weba");
    expect(extensionForRecordedType("audio/ogg; codecs=opus")).toBe("ogg");
    expect(extensionForRecordedType("audio/mp4;codecs=mp4a.40.2")).toBe("m4a");
    expect(extensionForRecordedType("AUDIO/WEBM")).toBe("weba");
    expect(extensionForRecordedType("video/webm;codecs=vp8,opus")).toBeNull();
    expect(extensionForRecordedType("audio/x-matroska")).toBeNull();
    expect(extensionForRecordedType("")).toBeNull();
    expect(baseMimeType("audio/ogg; codecs=opus")).toBe("audio/ogg");
  });

  it("produces names the upload picker accepts as audio", () => {
    for (const extension of ["weba", "ogg", "m4a"]) {
      const name = recordingFileName(extension, new Date("2026-11-12T10:20:30.456Z"));
      expect(name).toBe(`voice-message-20261112T102030Z.${extension}`);
      expect(guessKind(name)).toBe("audio");
      expect(ACCEPTED_FILE_EXTENSIONS).toContain(`.${extension}`);
    }
  });

  it("keeps the longest recording well under the upload limit (and Gemini's 14 MiB inline limit)", () => {
    const maxBytes = (MAX_RECORDING_SECONDS * RECORDING_BITS_PER_SECOND) / 8;
    expect(maxBytes).toBeLessThan(MAX_UPLOAD_BYTES);
    expect(maxBytes).toBeLessThan(14 * 1024 * 1024);
  });

  it("formats durations as m:ss", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(9.9)).toBe("0:09");
    expect(formatDuration(75)).toBe("1:15");
    expect(formatDuration(600)).toBe("10:00");
    expect(formatDuration(-3)).toBe("0:00");
  });

  it("needs getUserMedia, MediaRecorder and a secure context", () => {
    const mediaDevices = { getUserMedia: async () => ({}) as MediaStream };
    class Recorder {
      static isTypeSupported = () => true;
    }
    expect(checkRecordingSupport({ mediaDevices, MediaRecorder: Recorder, isSecureContext: true })).toBeNull();
    expect(checkRecordingSupport({ mediaDevices, MediaRecorder: Recorder, isSecureContext: false })).toBe(UNSUPPORTED_RECORDING_MESSAGE);
    expect(checkRecordingSupport({ MediaRecorder: Recorder })).toBe(UNSUPPORTED_RECORDING_MESSAGE);
    expect(checkRecordingSupport({ mediaDevices })).toBe(UNSUPPORTED_RECORDING_MESSAGE);
  });
});
