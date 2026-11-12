import { vi } from "vitest";
import { createFakeStream, type FakeTrack } from "./fakeWebRtc";

/**
 * jsdom has no MediaRecorder or microphone. This fake stands in for both so
 * the composer's recording flow can be tested: which format is requested,
 * what the produced file is named/typed as, and that every microphone track
 * is stopped. Real audio capture needs the manual test plan.
 */
export class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  /** Types `isTypeSupported` reports as recordable. */
  static supported = new Set<string>();
  /** What the "browser" actually records, overriding the requested type (null = the requested one). */
  static producedType: string | null = null;
  /** Bytes in the single chunk delivered on stop. */
  static chunkBytes = 2048;
  /**
   * "async" (default, like real browsers): `dataavailable` + `stop` fire on a
   * later task. "throws": stop() throws and no events fire — the recorder
   * can't be relied on to report back, so callers must release the mic themselves.
   */
  static stopBehavior: "async" | "throws" = "async";

  static isTypeSupported(type: string): boolean {
    return FakeMediaRecorder.supported.has(type);
  }

  state: RecordingState = "inactive";
  readonly mimeType: string;
  timeslice: number | undefined;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(
    readonly stream: MediaStream,
    readonly options: MediaRecorderOptions = {}
  ) {
    this.mimeType = FakeMediaRecorder.producedType ?? options.mimeType ?? "";
    FakeMediaRecorder.instances.push(this);
  }

  start(timeslice?: number): void {
    this.timeslice = timeslice;
    this.state = "recording";
  }

  stop(): void {
    if (this.state === "inactive") return;
    if (FakeMediaRecorder.stopBehavior === "throws") throw new DOMException("The recorder is in an invalid state", "InvalidStateError");
    this.state = "inactive";
    setTimeout(() => {
      this.ondataavailable?.({ data: new Blob([new Uint8Array(FakeMediaRecorder.chunkBytes)], { type: this.mimeType }) });
      this.onstop?.();
    }, 0);
  }

  /** Simulates the browser aborting the recording (device unplugged, etc.). */
  fail(): void {
    this.state = "inactive";
    this.onerror?.(new Event("error"));
  }
}

export interface FakeRecordingEnvironment {
  getUserMedia: ReturnType<typeof vi.fn>;
  /** Every track handed out by getUserMedia, to assert they were all stopped. */
  tracks: FakeTrack[];
  /** Resolves the next getUserMedia call that was told to wait (see `holdPermission`). */
  grantPermission(): void;
  restore(): void;
}

/**
 * Installs a fake microphone + MediaRecorder on `navigator` / `globalThis`.
 * `supported`: recordable types; `producedType`: what actually gets recorded;
 * `error`: getUserMedia rejects with this DOMException-like error;
 * `noRecorder`: the browser has no MediaRecorder; `holdPermission`: the
 * permission prompt stays open until `grantPermission()`.
 */
export function installFakeRecording(
  options: {
    supported?: string[];
    producedType?: string | null;
    error?: { name: string };
    noRecorder?: boolean;
    holdPermission?: boolean;
    chunkBytes?: number;
    stopBehavior?: "async" | "throws";
  } = {}
): FakeRecordingEnvironment {
  FakeMediaRecorder.instances = [];
  FakeMediaRecorder.stopBehavior = options.stopBehavior ?? "async";
  FakeMediaRecorder.supported = new Set(options.supported ?? ["audio/webm;codecs=opus", "audio/webm"]);
  FakeMediaRecorder.producedType = options.producedType ?? null;
  FakeMediaRecorder.chunkBytes = options.chunkBytes ?? 2048;

  const tracks: FakeTrack[] = [];
  let release: (() => void) | null = null;
  const getUserMedia = vi.fn(async (_constraints: MediaStreamConstraints) => {
    if (options.holdPermission) await new Promise<void>((resolve) => (release = resolve));
    if (options.error) throw options.error;
    const stream = createFakeStream(["audio"]);
    tracks.push(...stream.tracks);
    return stream;
  });

  const originalDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  const originalRecorder = Object.getOwnPropertyDescriptor(globalThis, "MediaRecorder");
  const originalSecure = Object.getOwnPropertyDescriptor(window, "isSecureContext");
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
  if (options.noRecorder) {
    delete (globalThis as Record<string, unknown>).MediaRecorder;
  } else {
    Object.defineProperty(globalThis, "MediaRecorder", { configurable: true, writable: true, value: FakeMediaRecorder });
  }

  return {
    getUserMedia,
    tracks,
    grantPermission: () => release?.(),
    restore: () => {
      if (originalDevices) Object.defineProperty(navigator, "mediaDevices", originalDevices);
      else delete (navigator as unknown as Record<string, unknown>).mediaDevices;
      if (originalRecorder) Object.defineProperty(globalThis, "MediaRecorder", originalRecorder);
      else delete (globalThis as Record<string, unknown>).MediaRecorder;
      if (originalSecure) Object.defineProperty(window, "isSecureContext", originalSecure);
      else delete (window as unknown as Record<string, unknown>).isSecureContext;
    },
  };
}
