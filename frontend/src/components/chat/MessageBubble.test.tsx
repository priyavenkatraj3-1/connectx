import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../../context/AuthContext";
import { mediaService } from "../../services/mediaService";
import { seedAuthenticatedSession } from "../../tests/testAuth";
import type { MessageDTO } from "../../types/message";
import { MessageBubble } from "./MessageBubble";

vi.mock("../../services/mediaService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/mediaService")>();
  return { ...actual, mediaService: { upload: vi.fn(), remove: vi.fn(), fetchContent: vi.fn() } };
});

const base: MessageDTO = {
  id: "msg-1",
  conversationId: "conv-1",
  senderId: "user-2",
  sender: { id: "user-2", displayName: "Grace Hopper", avatarUrl: null },
  contentType: "text",
  body: "Hello team",
  status: "sent",
  createdAt: new Date().toISOString(),
  editedAt: null,
  replyTo: null,
  mentions: [],
  attachment: null,
};

function renderBubble(message: MessageDTO, overrides: Partial<Parameters<typeof MessageBubble>[0]> = {}) {
  const handlers = { onReply: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn().mockResolvedValue(undefined) };
  render(
    <AuthProvider>
      <MessageBubble
        message={message}
        isOwn={message.senderId === "user-1"}
        showSenderName
        currentUserId="user-1"
        {...handlers}
        {...overrides}
      />
    </AuthProvider>
  );
  return handlers;
}

describe("MessageBubble", () => {
  beforeEach(() => {
    localStorage.clear();
    seedAuthenticatedSession();
  });

  it("shows the sender's name for others' messages in groups", () => {
    renderBubble(base);
    expect(screen.getByText("Grace Hopper")).toBeInTheDocument();
    expect(screen.getByText("Hello team")).toBeInTheDocument();
  });

  it("hides the sender name in direct chats", () => {
    renderBubble(base, { showSenderName: false });
    expect(screen.queryByText("Grace Hopper")).not.toBeInTheDocument();
  });

  it("renders the reply preview, or a deleted placeholder", () => {
    renderBubble({
      ...base,
      replyTo: { id: "m0", senderId: "user-3", senderDisplayName: "Alan", body: "Original text", contentType: "text", deleted: false },
    });
    const quote = screen.getByLabelText("Replying to");
    expect(within(quote).getByText("Alan")).toBeInTheDocument();
    expect(within(quote).getByText("Original text")).toBeInTheDocument();
  });

  it("marks a reply to a deleted message", () => {
    renderBubble({
      ...base,
      replyTo: { id: "m0", senderId: "user-3", senderDisplayName: "Alan", body: null, contentType: "text", deleted: true },
    });
    expect(screen.getByText("Original message was deleted")).toBeInTheDocument();
  });

  it("highlights confirmed @mentions", () => {
    renderBubble({
      ...base,
      body: "@Test User and @Alan Turing please review",
      mentions: [
        { userId: "user-1", displayName: "Test User" },
        { userId: "user-3", displayName: "Alan Turing" },
      ],
    });
    const mentions = screen.getAllByTestId("mention");
    expect(mentions.map((m) => m.textContent)).toEqual(["@Test User", "@Alan Turing"]);
  });

  it("shows an 'edited' label", () => {
    renderBubble({ ...base, editedAt: new Date().toISOString() });
    expect(screen.getByText(/edited/)).toBeInTheDocument();
  });

  it("offers only Reply on someone else's message", () => {
    renderBubble(base);
    expect(screen.getByRole("button", { name: "Reply" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit message" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete message" })).not.toBeInTheDocument();
  });

  it("lets the author edit, and delete after confirming", async () => {
    const user = userEvent.setup();
    const own = { ...base, senderId: "user-1", sender: { id: "user-1", displayName: "Test User", avatarUrl: null } };
    const handlers = renderBubble(own);

    await user.click(screen.getByRole("button", { name: "Edit message" }));
    expect(handlers.onEdit).toHaveBeenCalledWith(own);

    await user.click(screen.getByRole("button", { name: "Delete message" }));
    expect(handlers.onDelete).not.toHaveBeenCalled(); // needs confirmation first
    await user.click(within(screen.getByRole("group", { name: "Confirm delete" })).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(handlers.onDelete).toHaveBeenCalledWith(own));
  });

  it("shows the error and keeps the message when deletion fails", async () => {
    const user = userEvent.setup();
    const own = { ...base, senderId: "user-1" };
    renderBubble(own, { onDelete: vi.fn().mockRejectedValue(new Error("You can only modify your own messages")) });

    await user.click(screen.getByRole("button", { name: "Delete message" }));
    await user.click(within(screen.getByRole("group", { name: "Confirm delete" })).getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("You can only modify your own messages")).toBeInTheDocument();
    expect(screen.getByText("Hello team")).toBeInTheDocument();
  });

  describe("attachments", () => {
    const attachmentBase = {
      conversationId: "conv-1",
      messageId: "msg-1",
      uploaderId: "user-2",
      createdAt: new Date().toISOString(),
    };

    beforeEach(() => {
      vi.mocked(mediaService.fetchContent).mockReset();
      URL.createObjectURL = vi.fn(() => "blob:mock-url");
      URL.revokeObjectURL = vi.fn();
    });

    it("loads an image through the authenticated API and renders it", async () => {
      vi.mocked(mediaService.fetchContent).mockResolvedValue(new Blob(["png"], { type: "image/png" }));
      renderBubble({
        ...base,
        contentType: "image",
        body: null,
        attachment: { ...attachmentBase, id: "att-1", kind: "image", mimeType: "image/png", sizeBytes: 3, originalFilename: "cat.png" },
      });

      const img = await screen.findByRole("img", { name: "cat.png" });
      expect(img).toHaveAttribute("src", "blob:mock-url");
      expect(mediaService.fetchContent).toHaveBeenCalledWith("test-access-token", "att-1");
    });

    it("shows a clear error state when media can't be loaded", async () => {
      vi.mocked(mediaService.fetchContent).mockRejectedValue(new Error("You do not have access to this attachment"));
      renderBubble({
        ...base,
        contentType: "video",
        body: null,
        attachment: { ...attachmentBase, id: "att-2", kind: "video", mimeType: "video/mp4", sizeBytes: 10, originalFilename: "clip.mp4" },
      });
      expect(await screen.findByText("You do not have access to this attachment")).toBeInTheDocument();
    });

    it("shows documents as a file card with name and size, fetching only on demand", async () => {
      vi.mocked(mediaService.fetchContent).mockResolvedValue(new Blob(["%PDF"]));
      const user = userEvent.setup();
      renderBubble({
        ...base,
        contentType: "file",
        body: "Q3 report",
        attachment: {
          ...attachmentBase,
          id: "att-3",
          kind: "document",
          mimeType: "application/pdf",
          sizeBytes: 2048,
          originalFilename: "report.pdf",
        },
      });

      expect(screen.getByText("report.pdf")).toBeInTheDocument();
      expect(screen.getByText("2.0 KB")).toBeInTheDocument();
      expect(mediaService.fetchContent).not.toHaveBeenCalled();

      await user.click(screen.getByRole("button", { name: "Download report.pdf" }));
      expect(await screen.findByRole("link", { name: "Save report.pdf" })).toHaveAttribute("download", "report.pdf");
    });
  });
});
