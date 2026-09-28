import { useEffect, useRef, useState } from "react";
import type { CallEndSummary, CallPhase } from "../../context/CallContext";
import { formatCallDuration } from "../../context/CallContext";
import type { CallDTO } from "../../types/call";
import { Avatar } from "../ui/Avatar";
import { Button } from "../ui/Button";
import { MicIcon, MicOffIcon, PhoneOffIcon, VideoIcon, VideoOffIcon } from "../ui/icons";

export interface CallScreenProps {
  call: CallDTO;
  phase: Exclude<CallPhase, "idle">;
  /** Person's name (direct) or group name. */
  title: string;
  myUserId: string | undefined;
  localStream: MediaStream | null;
  remoteStreams: Record<string, MediaStream>;
  peerStates: Record<string, RTCPeerConnectionState>;
  micEnabled: boolean;
  cameraEnabled: boolean;
  remoteRinging: boolean;
  notice: string | null;
  endSummary: CallEndSummary | null;
  onHangUp(): void;
  onToggleMic(): void;
  onToggleCamera(): void;
  onRetry(): void;
  onDismiss(): void;
}

/** Re-renders once a second while `since` is set; returns elapsed seconds. */
function useElapsedSeconds(since: string | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  if (!since) return null;
  return Math.max(0, Math.floor((now - new Date(since).getTime()) / 1000));
}

function MediaElement({ stream, kind, muted, className }: { stream: MediaStream; kind: "video" | "audio"; muted?: boolean; className?: string }) {
  const ref = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.srcObject = stream;
    void element.play?.()?.catch?.(() => undefined);
  }, [stream]);

  return kind === "video" ? (
    <video ref={ref} autoPlay playsInline muted={muted} className={className} />
  ) : (
    <audio ref={ref} autoPlay muted={muted} />
  );
}

function statusLine(props: CallScreenProps, elapsed: number | null): string {
  const { phase, call, remoteRinging, peerStates } = props;
  if (phase === "outgoing") return remoteRinging ? "Ringing…" : "Calling…";
  const states = Object.values(peerStates);
  if (states.includes("disconnected")) return "Reconnecting…";
  if (states.includes("connected") && elapsed !== null) return formatCallDuration(elapsed);
  if (call.scope === "group" && call.participants.filter((p) => p.state === "joined").length <= 1) {
    return "Waiting for others to join…";
  }
  return "Connecting…";
}

function ControlButton({
  label,
  pressed,
  onClick,
  children,
  tone = "neutral",
}: {
  label: string;
  pressed?: boolean;
  onClick(): void;
  children: React.ReactNode;
  tone?: "neutral" | "danger";
}) {
  const colors =
    tone === "danger"
      ? "bg-red-600 text-white hover:bg-red-700"
      : pressed
        ? "bg-white text-slate-900 hover:bg-slate-200"
        : "bg-white/15 text-white hover:bg-white/25";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      className={`flex h-14 w-14 items-center justify-center rounded-full transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white ${colors}`}
    >
      {children}
    </button>
  );
}

/**
 * Full-screen call UI for outgoing, active and just-ended calls. Purely
 * presentational — all state comes from CallContext (see CallOverlay).
 */
export function CallScreen(props: CallScreenProps) {
  const { call, phase, title, myUserId, localStream, remoteStreams, micEnabled, cameraEnabled, notice, endSummary } = props;
  const isVideo = call.media === "video";
  const mediaConnected = Object.values(props.peerStates).includes("connected");
  // Prefer the server's timestamp; until it arrives, time from when this device saw media connect.
  const [locallyConnectedAt, setLocallyConnectedAt] = useState<string | null>(null);
  useEffect(() => {
    if (mediaConnected && !locallyConnectedAt) setLocallyConnectedAt(new Date().toISOString());
  }, [mediaConnected, locallyConnectedAt]);
  const elapsed = useElapsedSeconds(phase === "active" && mediaConnected ? (call.connectedAt ?? locallyConnectedAt) : null);
  const others = call.participants.filter((p) => p.userId !== myUserId);
  const joinedOthers = others.filter((p) => p.state === "joined");
  const remoteEntries = Object.entries(remoteStreams);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${isVideo ? "Video" : "Voice"} call with ${title}`}
      className="fixed inset-0 z-50 flex flex-col bg-slate-950 text-white"
    >
      <header className="flex flex-col items-center gap-1 px-4 pb-2 pt-8 text-center">
        <p className="text-xs uppercase tracking-wide text-white/50">
          {call.scope === "group" ? "Group " : ""}
          {isVideo ? "video call" : "voice call"}
        </p>
        <h2 className="max-w-full truncate text-xl font-semibold">{title}</h2>
        {phase !== "ended" && (
          <p className="text-sm text-white/70" aria-live="polite" data-testid="call-status">
            {statusLine(props, elapsed)}
          </p>
        )}
      </header>

      {notice && phase !== "ended" && (
        <p role="status" className="mx-auto mt-2 max-w-md rounded-lg bg-amber-500/20 px-3 py-2 text-center text-sm text-amber-100">
          {notice}
        </p>
      )}

      <main className="relative flex flex-1 items-center justify-center overflow-hidden p-4">
        {phase === "ended" ? (
          <div className="flex flex-col items-center gap-4 text-center">
            <Avatar name={title} size="lg" />
            <p className="text-lg font-medium">{endSummary?.title ?? "Call ended"}</p>
            {endSummary?.detail && <p className="max-w-sm text-sm text-white/70">{endSummary.detail}</p>}
          </div>
        ) : isVideo && remoteEntries.length > 0 ? (
          <div
            className={`grid h-full w-full gap-2 ${remoteEntries.length === 1 ? "grid-cols-1" : remoteEntries.length <= 4 ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-2 sm:grid-cols-3"}`}
          >
            {remoteEntries.map(([userId, stream]) => {
              const participant = call.participants.find((p) => p.userId === userId);
              return (
                <div key={userId} className="relative overflow-hidden rounded-xl bg-slate-900">
                  <MediaElement stream={stream} kind="video" className="h-full w-full object-cover" />
                  <span className="absolute bottom-2 left-2 flex items-center gap-1 rounded-md bg-black/50 px-2 py-0.5 text-xs">
                    {participant?.audioEnabled === false && <MicOffIcon width={12} height={12} aria-label="muted" />}
                    {participant?.displayName ?? "Participant"}
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-center gap-6">
            {(joinedOthers.length > 0 ? joinedOthers : others.slice(0, 1)).map((p) => (
              <div key={p.userId} className="flex flex-col items-center gap-2">
                <Avatar name={p.displayName} imageUrl={p.avatarUrl ?? undefined} size="lg" />
                <span className="flex items-center gap-1 text-sm text-white/80">
                  {p.audioEnabled === false && <MicOffIcon width={14} height={14} aria-label="muted" />}
                  {p.displayName}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Remote audio for voice calls (video elements carry their own audio). */}
        {phase !== "ended" && !isVideo && remoteEntries.map(([userId, stream]) => <MediaElement key={userId} stream={stream} kind="audio" />)}

        {phase !== "ended" && isVideo && localStream && cameraEnabled && (
          <div className="absolute bottom-4 right-4 h-36 w-24 overflow-hidden rounded-xl border border-white/20 bg-slate-800 shadow-lg sm:h-40 sm:w-56">
            <MediaElement stream={localStream} kind="video" muted className="h-full w-full -scale-x-100 object-cover" />
          </div>
        )}
      </main>

      {call.scope === "group" && phase === "active" && (
        <p className="px-4 text-center text-xs text-white/50">
          {joinedOthers.length + 1} in call · peer-to-peer, best for small groups
        </p>
      )}

      <footer className="flex items-center justify-center gap-4 px-4 pb-10 pt-6">
        {phase === "ended" ? (
          <>
            {endSummary?.canRetry && (
              <Button type="button" onClick={props.onRetry}>
                Call again
              </Button>
            )}
            <Button type="button" variant="secondary" onClick={props.onDismiss}>
              Close
            </Button>
          </>
        ) : (
          <>
            <ControlButton label={micEnabled ? "Mute microphone" : "Unmute microphone"} pressed={!micEnabled} onClick={props.onToggleMic}>
              {micEnabled ? <MicIcon /> : <MicOffIcon />}
            </ControlButton>
            {isVideo && (
              <ControlButton
                label={cameraEnabled ? "Turn camera off" : "Turn camera on"}
                pressed={!cameraEnabled}
                onClick={props.onToggleCamera}
              >
                {cameraEnabled ? <VideoIcon /> : <VideoOffIcon />}
              </ControlButton>
            )}
            <ControlButton label={phase === "outgoing" ? "Cancel call" : "End call"} tone="danger" onClick={props.onHangUp}>
              <PhoneOffIcon />
            </ControlButton>
          </>
        )}
      </footer>
    </div>
  );
}
