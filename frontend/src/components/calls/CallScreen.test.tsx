import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createFakeStream, makeCall, participant } from "../../tests/fakeWebRtc";
import type { CallHistoryEntryDTO } from "../../types/call";
import { CallHistoryItem, describeCallHistory } from "./CallHistoryItem";
import { CallScreen, type CallScreenProps } from "./CallScreen";

function renderScreen(overrides: Partial<CallScreenProps> = {}) {
  const handlers = {
    onHangUp: vi.fn(),
    onToggleMic: vi.fn(),
    onToggleCamera: vi.fn(),
    onRetry: vi.fn(),
    onDismiss: vi.fn(),
  };
  const props: CallScreenProps = {
    call: makeCall(),
    phase: "outgoing",
    title: "Grace Hopper",
    myUserId: "user-1",
    localStream: null,
    remoteStreams: {},
    peerStates: {},
    micEnabled: true,
    cameraEnabled: true,
    remoteRinging: false,
    notice: null,
    endSummary: null,
    ...handlers,
    ...overrides,
  };
  render(<CallScreen {...props} />);
  return handlers;
}

describe("CallScreen", () => {
  it("voice call: no camera control; mute and end call are wired up", async () => {
    const user = userEvent.setup();
    const handlers = renderScreen({ phase: "active", call: makeCall({ state: "accepted" }) });

    expect(screen.getByTestId("call-status")).toHaveTextContent("Connecting…");
    expect(screen.queryByRole("button", { name: /camera/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Mute microphone" }));
    await user.click(screen.getByRole("button", { name: "End call" }));
    expect(handlers.onToggleMic).toHaveBeenCalled();
    expect(handlers.onHangUp).toHaveBeenCalled();
  });

  it("shows reconnecting while a peer is temporarily disconnected", () => {
    renderScreen({ phase: "active", call: makeCall({ state: "connected" }), peerStates: { "user-2": "disconnected" } });
    expect(screen.getByTestId("call-status")).toHaveTextContent("Reconnecting…");
  });

  it("video call: local preview only while the camera is on, plus a camera toggle", async () => {
    const user = userEvent.setup();
    const stream = createFakeStream(["audio", "video"]);
    const handlers = renderScreen({ phase: "active", call: makeCall({ media: "video", state: "accepted" }), localStream: stream });
    expect(document.querySelectorAll("video")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Turn camera off" }));
    expect(handlers.onToggleCamera).toHaveBeenCalled();
  });

  it("group call: one tile per remote participant, and mute indicators", () => {
    const participants = [
      participant("user-1", "Test User", "initiator", "joined"),
      { ...participant("user-2", "Grace", "invitee", "joined"), audioEnabled: false },
      participant("user-3", "Alan", "invitee", "joined"),
    ];
    renderScreen({
      phase: "active",
      title: "Team",
      call: makeCall({ scope: "group", media: "video", state: "connected", participants }),
      remoteStreams: { "user-2": createFakeStream(["video"]), "user-3": createFakeStream(["video"]) },
      peerStates: { "user-2": "connecting" },
    });
    expect(screen.getByText("Grace")).toBeInTheDocument();
    expect(screen.getByText("Alan")).toBeInTheDocument();
    expect(screen.getAllByLabelText("muted")).toHaveLength(1);
    expect(screen.getByText(/3 in call · peer-to-peer/)).toBeInTheDocument();
  });

  it("ended: shows the summary with retry only when offered", async () => {
    const user = userEvent.setup();
    const handlers = renderScreen({
      phase: "ended",
      endSummary: { title: "Call failed", detail: "Couldn't connect.", canRetry: true },
    });
    expect(screen.getByText("Call failed")).toBeInTheDocument();
    expect(screen.queryByTestId("call-status")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Call again" }));
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(handlers.onRetry).toHaveBeenCalled();
    expect(handlers.onDismiss).toHaveBeenCalled();
  });

  it("shows notices such as a camera fallback", () => {
    renderScreen({ notice: "Your camera isn't available — you're on audio only." });
    expect(screen.getByRole("status")).toHaveTextContent("audio only");
  });
});

describe("call history entries", () => {
  const entry = (overrides: Partial<CallHistoryEntryDTO>): CallHistoryEntryDTO => ({
    ...makeCall({ state: "ended" }),
    direction: "outgoing",
    outcome: "completed",
    ...overrides,
  });

  it.each([
    [{ outcome: "completed", direction: "outgoing", durationSeconds: 125 }, "Outgoing voice call · 2:05", false],
    [{ outcome: "completed", direction: "incoming", media: "video", durationSeconds: 5 }, "Incoming video call · 0:05", false],
    [{ outcome: "missed", direction: "incoming" }, "Missed voice call", true],
    [{ outcome: "missed", direction: "incoming", scope: "group", media: "video" }, "Missed group video call", true],
    [{ outcome: "declined", direction: "incoming" }, "Declined voice call", false],
    [{ outcome: "declined", direction: "outgoing" }, "Voice call declined", false],
    [{ outcome: "no_answer", direction: "outgoing" }, "Voice call · no answer", false],
    [{ outcome: "cancelled", direction: "outgoing" }, "Cancelled voice call", false],
    [{ outcome: "failed", direction: "outgoing" }, "Voice call failed", false],
  ] as const)("%o → %s", (overrides, label, isMissed) => {
    expect(describeCallHistory(entry(overrides as Partial<CallHistoryEntryDTO>))).toEqual({ label, isMissed });
  });

  it("renders inline in the timeline", () => {
    render(<CallHistoryItem entry={entry({ outcome: "missed", direction: "incoming" })} />);
    expect(screen.getByTestId("call-history-item")).toHaveTextContent("Missed voice call");
  });
});
