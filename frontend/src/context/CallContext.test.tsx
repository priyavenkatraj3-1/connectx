import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CallButtons } from "../components/calls/CallButtons";
import { CallOverlay } from "../components/calls/CallOverlay";
import { callService } from "../services/callService";
import { conversationService } from "../services/conversationService";
import {
  createFakeMediaDevices,
  createFakeRealtime,
  FakePeerConnection,
  fakePeerFactory,
  makeCall,
  participant,
} from "../tests/fakeWebRtc";
import { seedAuthenticatedSession } from "../tests/testAuth";
import { AuthProvider } from "./AuthContext";
import { CallProvider } from "./CallContext";
import { ConversationsProvider } from "./ConversationsContext";
import { RealtimeContext } from "./RealtimeContext";

vi.mock("../services/callService", () => ({
  callService: { start: vi.fn(), end: vi.fn(), iceServers: vi.fn(), history: vi.fn(), active: vi.fn(), get: vi.fn() },
}));
vi.mock("../services/conversationService", () => ({
  conversationService: { list: vi.fn(), createDirect: vi.fn() },
}));

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";

function renderCalls(options: { mediaDevices?: MediaDevices; noWebRtc?: boolean } = {}) {
  const realtime = createFakeRealtime(CONNECTION_ID);
  const mediaDevices = options.mediaDevices ?? createFakeMediaDevices();
  render(
    <AuthProvider>
      <RealtimeContext.Provider value={realtime.value}>
        <ConversationsProvider>
          <CallProvider mediaDevices={mediaDevices} createPeerConnection={options.noWebRtc ? undefined : fakePeerFactory}>
            <CallButtons conversationId="conv-1" />
            <CallOverlay />
          </CallProvider>
        </ConversationsProvider>
      </RealtimeContext.Provider>
    </AuthProvider>
  );
  return { realtime, mediaDevices };
}

describe("CallContext + call UI", () => {
  beforeEach(() => {
    localStorage.clear();
    seedAuthenticatedSession(); // user-1, "Test User"
    FakePeerConnection.instances = [];
    vi.mocked(conversationService.list).mockResolvedValue([]);
    vi.mocked(callService.iceServers).mockResolvedValue([{ urls: ["stun:stun.example.com"] }]);
    vi.mocked(callService.start).mockReset();
    vi.mocked(callService.end).mockReset().mockResolvedValue(makeCall({ state: "cancelled" }));
  });

  describe("outgoing call", () => {
    it("asks for the microphone, starts the call from this tab, then goes Calling… → Ringing… → connected → ended", async () => {
      vi.mocked(callService.start).mockResolvedValue(makeCall());
      const user = userEvent.setup();
      const { realtime, mediaDevices } = renderCalls();

      await user.click(screen.getByRole("button", { name: "Start voice call" }));

      await waitFor(() => expect(screen.getByTestId("call-status")).toHaveTextContent("Calling…"));
      expect(mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: true, video: false });
      expect(callService.start).toHaveBeenCalledWith("test-access-token", "conv-1", "voice", CONNECTION_ID);
      expect(screen.getByRole("dialog", { name: "Voice call with Grace Hopper" })).toBeInTheDocument();
      // Buttons are disabled while a call is in progress.
      expect(screen.getByRole("button", { name: "Start video call" })).toBeDisabled();

      realtime.emit({ type: "call:ring", callId: "call-1", userId: "user-2" });
      expect(screen.getByTestId("call-status")).toHaveTextContent("Ringing…");

      const accepted = makeCall({
        state: "accepted",
        participants: [participant("user-1", "Test User", "initiator", "joined"), participant("user-2", "Grace Hopper", "invitee", "joined")],
      });
      realtime.emit({ type: "call:accept", call: accepted, userId: "user-2" });
      expect(screen.getByTestId("call-status")).toHaveTextContent("Connecting…");

      // The callee (the joiner) offers; we answer over the socket.
      realtime.emit({ type: "call:offer", callId: "call-1", fromUserId: "user-2", sdp: "remote-offer" });
      await waitFor(() =>
        expect(realtime.sent).toContainEqual({ type: "call:answer", callId: "call-1", toUserId: "user-2", sdp: "fake-answer-sdp" })
      );
      const pc = FakePeerConnection.instances[0]!;
      expect(pc.config.iceServers).toEqual([{ urls: ["stun:stun.example.com"] }]);
      expect(pc.remoteDescription).toEqual({ type: "offer", sdp: "remote-offer" });

      // ICE candidates are forwarded to the peer.
      realtime.emit({ type: "call:ice_candidate", callId: "call-1", fromUserId: "user-2", candidate: { candidate: "cand-1" } });
      await waitFor(() => expect(pc.addedCandidates).toEqual([{ candidate: "cand-1" }]));

      // Media connects → we report it once.
      act(() => pc.setState("connected"));
      await waitFor(() => expect(realtime.sent).toContainEqual({ type: "call:connected", callId: "call-1" }));
      await waitFor(() => expect(screen.getByTestId("call-status")).toHaveTextContent(/^\d+:\d{2}$/));

      realtime.emit({ type: "call:end", call: { ...accepted, state: "ended", endReason: "hangup", durationSeconds: 65 }, userId: "user-2" });
      expect(screen.getByText("Call ended")).toBeInTheDocument();
      expect(screen.getByText("1:05")).toBeInTheDocument();
    });

    it("shows a friendly message and rings nobody when microphone permission is denied", async () => {
      const user = userEvent.setup();
      renderCalls({ mediaDevices: createFakeMediaDevices({ error: { name: "NotAllowedError" } }) });

      await user.click(screen.getByRole("button", { name: "Start voice call" }));

      expect(await screen.findByRole("alertdialog")).toHaveTextContent(/needs permission to use your microphone/);
      expect(screen.queryByText(/NotAllowedError/)).not.toBeInTheDocument();
      expect(callService.start).not.toHaveBeenCalled();
    });

    it("explains when the browser can't make calls at all", async () => {
      const user = userEvent.setup();
      renderCalls({ noWebRtc: true });
      await user.click(screen.getByRole("button", { name: "Start video call" }));
      expect(await screen.findByRole("alertdialog")).toHaveTextContent(/Calls aren't supported here/);
      expect(callService.start).not.toHaveBeenCalled();
    });

    it("shows the server's reason when the call can't be placed (e.g. busy)", async () => {
      const { ApiError } = await import("../services/apiClient");
      vi.mocked(callService.start).mockRejectedValue(new ApiError("Grace Hopper is on another call", 409));
      const user = userEvent.setup();
      renderCalls();
      await user.click(screen.getByRole("button", { name: "Start voice call" }));
      expect(await screen.findByRole("alertdialog")).toHaveTextContent("Grace Hopper is on another call");
    });

    it("mute and hang up: toggles the mic track, then cancels a still-ringing call", async () => {
      vi.mocked(callService.start).mockResolvedValue(makeCall({ media: "video" }));
      const user = userEvent.setup();
      const { realtime } = renderCalls();

      await user.click(screen.getByRole("button", { name: "Start video call" }));
      await screen.findByTestId("call-status");

      await user.click(screen.getByRole("button", { name: "Mute microphone" }));
      expect(screen.getByRole("button", { name: "Unmute microphone" })).toHaveAttribute("aria-pressed", "true");
      await user.click(screen.getByRole("button", { name: "Turn camera off" }));
      expect(screen.getByRole("button", { name: "Turn camera on" })).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Cancel call" }));
      expect(realtime.sent).toContainEqual({ type: "call:end", callId: "call-1" });
      expect(screen.getByText("Call cancelled")).toBeInTheDocument();
    });

    it("offers to call again after no answer", async () => {
      vi.mocked(callService.start).mockResolvedValue(makeCall());
      const user = userEvent.setup();
      const { realtime } = renderCalls();
      await user.click(screen.getByRole("button", { name: "Start voice call" }));
      await screen.findByTestId("call-status");

      realtime.emit({ type: "call:end", call: makeCall({ state: "missed", endReason: "no_answer" }), userId: null });
      expect(screen.getByText("No answer")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Call again" }));
      await waitFor(() => expect(callService.start).toHaveBeenCalledTimes(2));
    });
  });

  describe("incoming call", () => {
    const incoming = makeCall({
      id: "call-9",
      initiatorId: "user-2",
      media: "video",
      participants: [participant("user-2", "Grace Hopper", "initiator", "joined"), participant("user-1", "Test User", "invitee", "invited")],
    });

    it("rings, acknowledges, and on accept gets the camera and offers to the caller", async () => {
      const user = userEvent.setup();
      const { realtime, mediaDevices } = renderCalls();

      realtime.emit({ type: "call:invite", call: incoming });
      expect(screen.getByRole("alertdialog", { name: "Incoming video call from Grace Hopper" })).toBeInTheDocument();
      expect(realtime.sent).toContainEqual({ type: "call:ring", callId: "call-9" });

      await user.click(screen.getByRole("button", { name: "Accept video call" }));
      await waitFor(() => expect(realtime.sent).toContainEqual({ type: "call:accept", callId: "call-9" }));
      expect(mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: true, video: true });

      // The server confirms our join; as the joiner we send the offer.
      realtime.emit({
        type: "call:accept",
        userId: "user-1",
        call: {
          ...incoming,
          state: "accepted",
          participants: [participant("user-2", "Grace Hopper", "initiator", "joined"), participant("user-1", "Test User", "invitee", "joined")],
        },
      });
      await waitFor(() =>
        expect(realtime.sent).toContainEqual({ type: "call:offer", callId: "call-9", toUserId: "user-2", sdp: "fake-offer-sdp" })
      );
      expect(screen.getByRole("dialog", { name: "Video call with Grace Hopper" })).toBeInTheDocument();
    });

    it("declines", async () => {
      const user = userEvent.setup();
      const { realtime } = renderCalls();
      realtime.emit({ type: "call:invite", call: incoming });
      await user.click(screen.getByRole("button", { name: "Decline call" }));
      expect(realtime.sent).toContainEqual({ type: "call:decline", callId: "call-9" });
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });

    it("stops ringing when answered on another device, or when the caller gives up", () => {
      const { realtime } = renderCalls();
      realtime.emit({ type: "call:invite", call: incoming });
      realtime.emit({ type: "call:accept", call: { ...incoming, state: "accepted" }, userId: "user-1" });
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();

      realtime.emit({ type: "call:invite", call: { ...incoming, id: "call-10" } });
      expect(screen.getByRole("alertdialog")).toBeInTheDocument();
      realtime.emit({ type: "call:cancel", call: { ...incoming, id: "call-10", state: "cancelled" } });
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });

    it("declines automatically if the camera/mic can't be used, so the caller isn't left ringing", async () => {
      const user = userEvent.setup();
      const { realtime } = renderCalls({ mediaDevices: createFakeMediaDevices({ error: { name: "NotAllowedError" } }) });
      realtime.emit({ type: "call:invite", call: incoming });
      await user.click(screen.getByRole("button", { name: "Accept video call" }));
      expect(await screen.findByRole("alertdialog")).toHaveTextContent(/needs permission to use your camera and microphone/);
      expect(realtime.sent).toContainEqual({ type: "call:decline", callId: "call-9" });
    });
  });
});
