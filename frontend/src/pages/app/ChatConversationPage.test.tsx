import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../../context/AuthContext";
import { ConversationsProvider } from "../../context/ConversationsContext";
import { RealtimeProvider } from "../../context/RealtimeContext";
import { conversationService } from "../../services/conversationService";
import { messageService } from "../../services/messageService";
import { seedAuthenticatedSession } from "../../tests/testAuth";
import type { ConversationSummary } from "../../types/conversation";
import type { MessageDTO } from "../../types/message";
import { ChatConversationPage } from "./ChatConversationPage";

vi.mock("../../services/conversationService", () => ({
  conversationService: { list: vi.fn(), createDirect: vi.fn() },
}));
vi.mock("../../services/messageService", () => ({
  messageService: { list: vi.fn(), send: vi.fn(), markRead: vi.fn() },
}));

const conversation: ConversationSummary = {
  id: "conv-1",
  type: "direct",
  otherParticipant: { id: "user-2", displayName: "Grace Hopper", avatarUrl: null, statusMessage: null },
  lastMessage: null,
  unreadCount: 0,
  updatedAt: new Date().toISOString(),
};

const existingMessage: MessageDTO = {
  id: "msg-1",
  conversationId: "conv-1",
  senderId: "user-2",
  contentType: "text",
  body: "Hey there!",
  status: "sent",
  createdAt: new Date().toISOString(),
  editedAt: null,
};

function renderPage() {
  return render(
    <AuthProvider>
      <RealtimeProvider>
        <ConversationsProvider>
          <MemoryRouter initialEntries={["/app/chat/conv-1"]}>
            <Routes>
              <Route path="/app/chat/:conversationId" element={<ChatConversationPage />} />
            </Routes>
          </MemoryRouter>
        </ConversationsProvider>
      </RealtimeProvider>
    </AuthProvider>
  );
}

describe("ChatConversationPage", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(conversationService.list).mockResolvedValue([conversation]);
    vi.mocked(messageService.markRead).mockResolvedValue(undefined);
  });

  it("loads and displays message history, marking it read", async () => {
    seedAuthenticatedSession();
    vi.mocked(messageService.list).mockResolvedValue({ items: [existingMessage], hasMore: false });

    renderPage();

    await waitFor(() => expect(screen.getByText("Hey there!")).toBeInTheDocument());
    expect(screen.getByText("Grace Hopper")).toBeInTheDocument();
    await waitFor(() => expect(messageService.markRead).toHaveBeenCalledWith("test-access-token", "conv-1", "msg-1"));
  });

  it("sends a new message and appends it to the thread", async () => {
    seedAuthenticatedSession();
    vi.mocked(messageService.list).mockResolvedValue({ items: [], hasMore: false });
    const sent: MessageDTO = {
      id: "msg-2",
      conversationId: "conv-1",
      senderId: "user-1",
      contentType: "text",
      body: "Hello!",
      status: "sent",
      createdAt: new Date().toISOString(),
      editedAt: null,
    };
    vi.mocked(messageService.send).mockResolvedValue(sent);

    renderPage();

    await waitFor(() => expect(screen.getByPlaceholderText("Type a message")).toBeInTheDocument());

    await userEvent.type(screen.getByPlaceholderText("Type a message"), "Hello!");
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(messageService.send).toHaveBeenCalledWith("test-access-token", "conv-1", "Hello!"));
    await waitFor(() => expect(screen.getByText("Hello!")).toBeInTheDocument());
  });
});
