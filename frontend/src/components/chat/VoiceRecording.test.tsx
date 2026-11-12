import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../../context/AuthContext";
import { MAX_RECORDING_SECONDS, TOO_SHORT_MESSAGE, UNSUPPORTED_FORMAT_MESSAGE, UNSUPPORTED_RECORDING_MESSAGE } from "../../lib/media/voiceRecording";
import { mediaService } from "../../services/mediaService";
import { messageService } from "../../services/messageService";
import { FakeMediaRecorder, installFakeRecording, type FakeRecordingEnvironment } from "../../tests/fakeMediaRecorder";
import { seedAuthenticatedSession } from "../../tests/testAuth";
import type { AttachmentDTO } from "../../types/media";
import type { MessageDTO } from "../../types/message";
import { MessageComposer } from "./MessageComposer";

vi.mock("../../services/messageService", () => ({
  messageService: { list: vi.fn(), send: vi.fn(), edit: vi.fn(), remove: vi.fn(), markRead: vi.fn() },
}));
vi.mock("../../services/mediaService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/mediaService")>();
  return { ...actual, mediaService: { upload: vi.fn(), remove: vi.fn(), fetchContent: vi.fn() } };
});

const voiceAttachment: AttachmentDTO = {
  id: "att-voice",
  conversationId: "conv-1",
  messageId: null,
  uploaderId: "user-1",
  kind: "audio",
  mimeType: "audio/webm",
  sizeBytes: 2048,
  originalFilename: "voice-message.weba",
  createdAt: new Date().toISOString(),
};

const sentMessage: MessageDTO = {
  id: "msg-voice",
  conversationId: "conv-1",
  senderId: "user-1",
  contentType: "audio",
  body: null,
  status: "sent",
  createdAt: new Date().toISOString(),
  editedAt: null,
};

function composer(props: Partial<Parameters<typeof MessageComposer>[0]> = {}) {
  return (
    <AuthProvider>
      <MessageComposer
        conversationId="conv-1"
        mentionCandidates={[]}
        replyingTo={null}
        onCancelReply={vi.fn()}
        editing={null}
        onCancelEdit={vi.fn()}
        onSent={vi.fn()}
        onEdited={vi.fn()}
        {...props}
      />
    </AuthProvider>
  );
}

/** Lets the fake recording run for `ms` of (fake) time. */
const elapse = (ms: number) => act(() => vi.advanceTimersByTime(ms));

describe("MessageComposer — voice recording", () => {
  let env: FakeRecordingEnvironment;
  let restoreUrls: () => void;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    localStorage.clear();
    seedAuthenticatedSession();
    vi.mocked(mediaService.upload).mockReset().mockReturnValue({ promise: Promise.resolve(voiceAttachment), abort: vi.fn() });
    vi.mocked(mediaService.remove).mockReset().mockResolvedValue(undefined);
    vi.mocked(messageService.send).mockReset().mockResolvedValue(sentMessage);
    const create = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const revoke = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    Object.defineProperty(URL, "createObjectURL", { configurable: true, writable: true, value: vi.fn(() => "blob:voice-preview") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, writable: true, value: vi.fn() });
    restoreUrls = () => {
      for (const [name, original] of [["createObjectURL", create], ["revokeObjectURL", revoke]] as const) {
        if (original) Object.defineProperty(URL, name, original);
        else delete (URL as unknown as Record<string, unknown>)[name];
      }
    };
  });

  afterEach(() => {
    // Unmount first: unmounting revokes preview URLs, so the URL stubs must still be in place.
    cleanup();
    env?.restore();
    restoreUrls();
    vi.useRealTimers();
  });

  const user = () => userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const uploadedFile = () => vi.mocked(mediaService.upload).mock.calls[0]![2];

  it("asks for the microphone only on click, records with a timer, then previews and sends through the attachment flow", async () => {
    env = installFakeRecording();
    const u = user();
    render(composer());

    expect(env.getUserMedia).not.toHaveBeenCalled();
    await u.click(screen.getByRole("button", { name: "Record voice message" }));
    expect(env.getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(await screen.findByText("Recording")).toBeInTheDocument();
    expect(FakeMediaRecorder.instances[0]!.options).toMatchObject({ mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 32000 });
    // The text box and Send button are out of the way while recording.
    expect(screen.queryByRole("textbox", { name: "Message" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send message" })).not.toBeInTheDocument();

    await elapse(3200);
    expect(screen.getByRole("timer", { name: "Recording duration" })).toHaveTextContent("0:03");

    await u.click(screen.getByRole("button", { name: "Stop recording" }));
    expect(env.tracks.length).toBeGreaterThan(0);
    for (const track of env.tracks) expect(track.stop).toHaveBeenCalled();

    // Uploaded as WebM *audio* (.weba), never .webm (which the server stores as video).
    const file = uploadedFile();
    expect(file.name).toMatch(/^voice-message-\d{8}T\d{6}Z\.weba$/);
    expect(file.type).toBe("audio/webm");
    expect(vi.mocked(mediaService.upload).mock.calls[0]![1]).toBe("conv-1");

    expect(await screen.findByText("Ready to send")).toBeInTheDocument();
    expect(screen.getByLabelText("Voice message preview")).toHaveAttribute("src", "blob:voice-preview");

    await u.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(messageService.send).toHaveBeenCalledWith("test-access-token", "conv-1", "", expect.objectContaining({ attachmentId: "att-voice" })));
    expect(screen.queryByTestId("pending-attachment")).not.toBeInTheDocument();
  });

  it.each([
    ["Chrome/Edge (WebM/Opus)", ["audio/webm;codecs=opus"], null, "weba", "audio/webm"],
    ["Firefox (Ogg/Opus)", ["audio/ogg;codecs=opus"], null, "ogg", "audio/ogg"],
    ["Safari (MP4)", ["audio/mp4"], "audio/mp4;codecs=mp4a.40.2", "m4a", "audio/mp4"],
  ])("%s recordings get an extension the server stores as audio", async (_browser, supported, produced, extension, type) => {
    env = installFakeRecording({ supported, producedType: produced });
    const u = user();
    render(composer());
    await u.click(screen.getByRole("button", { name: "Record voice message" }));
    await screen.findByText("Recording");
    await elapse(1500);
    await u.click(screen.getByRole("button", { name: "Stop recording" }));

    const file = uploadedFile();
    expect(file.name.endsWith(`.${extension}`)).toBe(true);
    expect(file.type).toBe(type);
  });

  it("refuses a format the server can't store as audio, without uploading", async () => {
    env = installFakeRecording({ supported: [], producedType: "video/webm;codecs=vp8,opus" });
    const u = user();
    render(composer());
    await u.click(screen.getByRole("button", { name: "Record voice message" }));
    await screen.findByText("Recording");
    expect(FakeMediaRecorder.instances[0]!.options.mimeType).toBeUndefined(); // nothing preferred was supported → browser default
    await elapse(1500);
    await u.click(screen.getByRole("button", { name: "Stop recording" }));

    expect(screen.getByRole("alert")).toHaveTextContent(UNSUPPORTED_FORMAT_MESSAGE);
    expect(mediaService.upload).not.toHaveBeenCalled();
    for (const track of env.tracks) expect(track.stop).toHaveBeenCalled();
  });

  it("discarding a recording uploads nothing and releases the microphone", async () => {
    env = installFakeRecording();
    const u = user();
    render(composer());
    await u.click(screen.getByRole("button", { name: "Record voice message" }));
    await screen.findByText("Recording");
    await elapse(2000);
    await u.click(screen.getByRole("button", { name: "Discard recording" }));

    for (const track of env.tracks) expect(track.stop).toHaveBeenCalled();
    expect(mediaService.upload).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Record voice message" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message" })).toBeInTheDocument();
  });

  it("explains a denied microphone permission", async () => {
    env = installFakeRecording({ error: { name: "NotAllowedError" } });
    const u = user();
    render(composer());
    await u.click(screen.getByRole("button", { name: "Record voice message" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("ConnectX needs permission to use your microphone");
    expect(FakeMediaRecorder.instances).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Record voice message" })).toBeInTheDocument();
  });

  it("says when the browser can't record, without asking for the microphone", async () => {
    env = installFakeRecording({ noRecorder: true });
    const u = user();
    render(composer());
    await u.click(screen.getByRole("button", { name: "Record voice message" }));

    expect(screen.getByRole("alert")).toHaveTextContent(UNSUPPORTED_RECORDING_MESSAGE);
    expect(env.getUserMedia).not.toHaveBeenCalled();
  });

  it("treats an instant stop as an accidental tap", async () => {
    env = installFakeRecording();
    const u = user();
    render(composer());
    await u.click(screen.getByRole("button", { name: "Record voice message" }));
    await screen.findByText("Recording");
    await u.click(screen.getByRole("button", { name: "Stop recording" }));

    expect(screen.getByRole("alert")).toHaveTextContent(TOO_SHORT_MESSAGE);
    expect(mediaService.upload).not.toHaveBeenCalled();
  });

  it("refuses a recording over the upload size limit, with a clear message", async () => {
    env = installFakeRecording({ chunkBytes: 26 * 1024 * 1024 });
    const u = user();
    render(composer());
    await u.click(screen.getByRole("button", { name: "Record voice message" }));
    await screen.findByText("Recording");
    await elapse(1500);
    await u.click(screen.getByRole("button", { name: "Stop recording" }));

    expect(screen.getByRole("alert")).toHaveTextContent("This recording is too large to send (limit 25 MB)");
    expect(mediaService.upload).not.toHaveBeenCalled();
  });

  it("stops by itself at the length limit and keeps the recording", async () => {
    env = installFakeRecording();
    const u = user();
    render(composer());
    await u.click(screen.getByRole("button", { name: "Record voice message" }));
    await screen.findByText("Recording");
    await elapse(MAX_RECORDING_SECONDS * 1000 + 500);

    expect(mediaService.upload).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent("Recording stopped at the 10-minute limit.");
    for (const track of env.tracks) expect(track.stop).toHaveBeenCalled();
  });

  it("releases the microphone when the recorder fails mid-recording", async () => {
    env = installFakeRecording();
    const u = user();
    render(composer());
    await u.click(screen.getByRole("button", { name: "Record voice message" }));
    await screen.findByText("Recording");
    act(() => FakeMediaRecorder.instances[0]!.fail());

    expect(screen.getByRole("alert")).toHaveTextContent("Recording stopped unexpectedly");
    for (const track of env.tracks) expect(track.stop).toHaveBeenCalled();
    expect(mediaService.upload).not.toHaveBeenCalled();
  });

  it("releases the microphone even when the recorder can't stop cleanly", async () => {
    env = installFakeRecording({ stopBehavior: "throws" });
    const u = user();
    render(composer());
    await u.click(screen.getByRole("button", { name: "Record voice message" }));
    await screen.findByText("Recording");
    await elapse(1500);
    await u.click(screen.getByRole("button", { name: "Stop recording" }));

    expect(screen.getByRole("alert")).toHaveTextContent("Recording stopped unexpectedly");
    expect(env.tracks[0]!.stop).toHaveBeenCalled();
    expect(mediaService.upload).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Record voice message" })).toBeInTheDocument();
  });

  it("releases the microphone on unmount even when the recorder never reports back", async () => {
    env = installFakeRecording({ stopBehavior: "throws" });
    const u = user();
    const { unmount } = render(composer());
    await u.click(screen.getByRole("button", { name: "Record voice message" }));
    await screen.findByText("Recording");
    unmount();
    expect(env.tracks[0]!.stop).toHaveBeenCalled();
  });

  it("releases the microphone on unmount, and when switching chats", async () => {
    env = installFakeRecording();
    const u = user();
    const { rerender, unmount } = render(composer());
    await u.click(screen.getByRole("button", { name: "Record voice message" }));
    await screen.findByText("Recording");

    rerender(composer({ conversationId: "conv-2" }));
    expect(env.tracks[0]!.stop).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Record voice message" })).toBeInTheDocument();

    await u.click(screen.getByRole("button", { name: "Record voice message" }));
    await screen.findByText("Recording");
    unmount();
    expect(env.tracks[1]!.stop).toHaveBeenCalled();
    expect(mediaService.upload).not.toHaveBeenCalled();
  });

  it("a permission prompt answered after cancelling never leaves the microphone on", async () => {
    env = installFakeRecording({ holdPermission: true });
    const u = user();
    render(composer());
    await u.click(screen.getByRole("button", { name: "Record voice message" }));
    expect(screen.getByText("Waiting for microphone permission…")).toBeInTheDocument();
    await u.click(screen.getByRole("button", { name: "Discard recording" }));

    await act(async () => env.grantPermission());
    await waitFor(() => expect(env.tracks).toHaveLength(1));
    expect(env.tracks[0]!.stop).toHaveBeenCalled();
    expect(FakeMediaRecorder.instances).toHaveLength(0);
    expect(screen.queryByText("Recording")).not.toBeInTheDocument();
  });

  it("removing the recorded preview deletes the unsent upload", async () => {
    env = installFakeRecording();
    const u = user();
    render(composer());
    await u.click(screen.getByRole("button", { name: "Record voice message" }));
    await screen.findByText("Recording");
    await elapse(1500);
    await u.click(screen.getByRole("button", { name: "Stop recording" }));
    await screen.findByText("Ready to send");

    await u.click(screen.getByRole("button", { name: "Remove attachment" }));
    expect(mediaService.remove).toHaveBeenCalledWith("test-access-token", "att-voice");
    expect(screen.getByRole("button", { name: "Record voice message" })).toBeInTheDocument();
  });

  it("isn't offered while editing a message or with an attachment already pending", async () => {
    env = installFakeRecording();
    const editing: MessageDTO = { ...sentMessage, id: "msg-edit", contentType: "text", body: "hello" };
    const { rerender } = render(composer({ editing }));
    expect(screen.queryByRole("button", { name: "Record voice message" })).not.toBeInTheDocument();

    rerender(composer());
    const u = user();
    await u.upload(screen.getByTestId("attachment-input"), new File(["%PDF"], "notes.pdf", { type: "application/pdf" }));
    await screen.findByTestId("pending-attachment");
    expect(screen.queryByRole("button", { name: "Record voice message" })).not.toBeInTheDocument();
  });
});
