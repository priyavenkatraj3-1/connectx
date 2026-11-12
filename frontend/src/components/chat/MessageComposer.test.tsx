import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../../context/AuthContext";
import { ApiError } from "../../services/apiClient";
import { mediaService } from "../../services/mediaService";
import { messageService } from "../../services/messageService";
import { seedAuthenticatedSession } from "../../tests/testAuth";
import type { AttachmentDTO } from "../../types/media";
import type { MessageDTO } from "../../types/message";
import { MessageComposer, type MentionCandidate } from "./MessageComposer";

vi.mock("../../services/messageService", () => ({
  messageService: { list: vi.fn(), send: vi.fn(), edit: vi.fn(), remove: vi.fn(), markRead: vi.fn() },
}));
vi.mock("../../services/mediaService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/mediaService")>();
  return { ...actual, mediaService: { upload: vi.fn(), remove: vi.fn(), fetchContent: vi.fn() } };
});

const sentMessage: MessageDTO = {
  id: "msg-9",
  conversationId: "conv-1",
  senderId: "user-1",
  contentType: "text",
  body: "ok",
  status: "sent",
  createdAt: new Date().toISOString(),
  editedAt: null,
};

const uploaded: AttachmentDTO = {
  id: "att-1",
  conversationId: "conv-1",
  messageId: null,
  uploaderId: "user-1",
  kind: "document",
  mimeType: "application/pdf",
  sizeBytes: 2048,
  originalFilename: "report.pdf",
  createdAt: new Date().toISOString(),
};

function renderComposer(props: Partial<Parameters<typeof MessageComposer>[0]> = {}) {
  const onSent = vi.fn();
  const utils = render(
    <AuthProvider>
      <MessageComposer
        conversationId="conv-1"
        mentionCandidates={[]}
        replyingTo={null}
        onCancelReply={vi.fn()}
        editing={null}
        onCancelEdit={vi.fn()}
        onSent={onSent}
        onEdited={vi.fn()}
        {...props}
      />
    </AuthProvider>
  );
  return { ...utils, onSent };
}

/** A controllable fake upload: resolve/reject it from the test. */
function deferredUpload() {
  let resolve!: (a: AttachmentDTO) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<AttachmentDTO>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  let progress: ((fraction: number) => void) | undefined;
  vi.mocked(mediaService.upload).mockImplementation((_token, _conv, _file, onProgress) => {
    progress = onProgress;
    return { promise, abort: vi.fn() };
  });
  return { resolve, reject, progress: (f: number) => progress?.(f) };
}

describe("MessageComposer — attachments", () => {
  beforeEach(() => {
    localStorage.clear();
    seedAuthenticatedSession();
    vi.mocked(mediaService.upload).mockReset();
    vi.mocked(messageService.send).mockReset().mockResolvedValue(sentMessage);
  });

  it("rejects an unsupported file type without uploading it", async () => {
    const user = userEvent.setup({ applyAccept: false });
    renderComposer();

    await user.upload(screen.getByTestId("attachment-input"), new File(["MZ"], "setup.exe", { type: "application/x-msdownload" }));

    expect(await screen.findByRole("alert")).toHaveTextContent('".exe" files aren\'t supported');
    expect(mediaService.upload).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  });

  it("shows upload progress, then 'Ready to send', and sends the attachment id with the caption", async () => {
    const upload = deferredUpload();
    const user = userEvent.setup();
    const { onSent } = renderComposer();

    await user.upload(screen.getByTestId("attachment-input"), new File(["%PDF-1.7"], "report.pdf", { type: "application/pdf" }));

    expect(screen.getByText("Uploading…")).toBeInTheDocument();
    upload.progress(0.5);
    await waitFor(() => expect(screen.getByRole("progressbar", { name: "Upload progress" })).toHaveAttribute("aria-valuenow", "50"));
    // Can't send while the upload is still in flight.
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();

    upload.resolve(uploaded);
    expect(await screen.findByText("Ready to send")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Message"), "Q3 numbers");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(messageService.send).toHaveBeenCalledWith("test-access-token", "conv-1", "Q3 numbers", {
        replyToMessageId: undefined,
        mentionedUserIds: undefined,
        attachmentId: "att-1",
      })
    );
    expect(onSent).toHaveBeenCalledWith(sentMessage);
    await waitFor(() => expect(screen.queryByTestId("pending-attachment")).not.toBeInTheDocument());
  });

  it("never shows a server-rejected upload as ready, and blocks sending it", async () => {
    const upload = deferredUpload();
    const user = userEvent.setup();
    renderComposer();

    await user.upload(screen.getByTestId("attachment-input"), new File(["not really a png"], "cat.png", { type: "image/png" }));
    upload.reject(new ApiError('File contents do not match the ".png" file type', 415));

    expect(await screen.findByRole("alert")).toHaveTextContent("File contents do not match");
    expect(screen.queryByText("Ready to send")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Remove attachment" }));
    expect(screen.queryByTestId("pending-attachment")).not.toBeInTheDocument();
  });

  it("sends a caption-less media message", async () => {
    const upload = deferredUpload();
    const user = userEvent.setup();
    renderComposer();

    await user.upload(screen.getByTestId("attachment-input"), new File(["%PDF-1.7"], "report.pdf"));
    upload.resolve(uploaded);
    await screen.findByText("Ready to send");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(messageService.send).toHaveBeenCalledWith("test-access-token", "conv-1", "", expect.objectContaining({ attachmentId: "att-1" }))
    );
  });
});

describe("MessageComposer — mentions, replies and edits", () => {
  const members: MentionCandidate[] = [
    { userId: "user-2", displayName: "Grace Hopper" },
    { userId: "user-3", displayName: "Alan Turing" },
  ];

  beforeEach(() => {
    localStorage.clear();
    seedAuthenticatedSession();
    vi.mocked(messageService.send).mockReset().mockResolvedValue(sentMessage);
    vi.mocked(messageService.edit).mockReset().mockResolvedValue(sentMessage);
  });

  it("suggests members after '@' and sends the picked user's id", async () => {
    const user = userEvent.setup();
    renderComposer({ mentionCandidates: members });

    await user.type(screen.getByLabelText("Message"), "hey @gra");
    const suggestion = await screen.findByRole("option", { name: "@Grace Hopper" });
    expect(screen.queryByRole("option", { name: "@Alan Turing" })).not.toBeInTheDocument();

    await user.click(suggestion);
    expect(screen.getByLabelText("Message")).toHaveValue("hey @Grace Hopper ");

    await user.type(screen.getByLabelText("Message"), "look");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(messageService.send).toHaveBeenCalledWith("test-access-token", "conv-1", "hey @Grace Hopper look", {
        replyToMessageId: undefined,
        mentionedUserIds: ["user-2"],
        attachmentId: undefined,
      })
    );
  });

  it("drops a mention whose @name was deleted from the text before sending", async () => {
    const user = userEvent.setup();
    renderComposer({ mentionCandidates: members });

    await user.type(screen.getByLabelText("Message"), "@Ala");
    await user.click(await screen.findByRole("option", { name: "@Alan Turing" }));
    await user.clear(screen.getByLabelText("Message"));
    await user.type(screen.getByLabelText("Message"), "never mind");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    // No extras left → the plain Phase 2 call shape.
    await waitFor(() => expect(messageService.send).toHaveBeenCalledWith("test-access-token", "conv-1", "never mind"));
  });

  it("includes the reply target", async () => {
    const user = userEvent.setup();
    const onCancelReply = vi.fn();
    const original: MessageDTO = { ...sentMessage, id: "msg-1", senderId: "user-2", body: "Lunch?", sender: { id: "user-2", displayName: "Grace Hopper", avatarUrl: null } };
    renderComposer({ replyingTo: original, onCancelReply });

    expect(screen.getByText("Replying to Grace Hopper")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Message"), "Yes!");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(messageService.send).toHaveBeenCalledWith("test-access-token", "conv-1", "Yes!", {
        replyToMessageId: "msg-1",
        mentionedUserIds: undefined,
        attachmentId: undefined,
      })
    );
    expect(onCancelReply).toHaveBeenCalled();
  });

  it("loads the message into the composer in edit mode and saves via the edit API", async () => {
    const user = userEvent.setup();
    const onCancelEdit = vi.fn();
    renderComposer({ editing: { ...sentMessage, body: "teh typo" }, onCancelEdit });

    expect(screen.getByText("Editing message")).toBeInTheDocument();
    expect(screen.getByLabelText("Message")).toHaveValue("teh typo");
    expect(screen.queryByRole("button", { name: "Attach a file" })).not.toBeInTheDocument();

    await user.clear(screen.getByLabelText("Message"));
    await user.type(screen.getByLabelText("Message"), "the typo");
    await user.click(screen.getByRole("button", { name: "Save edit" }));

    await waitFor(() => expect(messageService.edit).toHaveBeenCalledWith("test-access-token", "conv-1", "msg-9", "the typo", []));
    expect(onCancelEdit).toHaveBeenCalled();
  });

  it("keeps the draft and shows the server's error when sending fails", async () => {
    vi.mocked(messageService.send).mockRejectedValue(new ApiError("You do not have access to this conversation", 403));
    const user = userEvent.setup();
    renderComposer();

    await user.type(screen.getByLabelText("Message"), "hello?");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("You do not have access to this conversation");
    expect(screen.getByLabelText("Message")).toHaveValue("hello?");
  });

  it("inserts an emoji from the picker at the caret", async () => {
    const user = userEvent.setup();
    renderComposer();
    const textarea = screen.getByPlaceholderText(/message/i) as HTMLTextAreaElement;
    await user.type(textarea, "See you");
    textarea.setSelectionRange(3, 3);

    await user.click(screen.getByRole("button", { name: "Insert emoji" }));
    await user.click(within(screen.getByRole("dialog", { name: "Insert emoji" })).getByRole("button", { name: "👋" }));

    expect(textarea.value).toBe("See👋 you");
    expect(screen.queryByRole("dialog", { name: "Insert emoji" })).not.toBeInTheDocument();
  });
});
