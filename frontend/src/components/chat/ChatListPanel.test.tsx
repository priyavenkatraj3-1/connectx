import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../../context/AuthContext";
import { ConversationsProvider } from "../../context/ConversationsContext";
import { RealtimeProvider } from "../../context/RealtimeContext";
import { conversationService } from "../../services/conversationService";
import { seedAuthenticatedSession } from "../../tests/testAuth";
import type { ConversationSummary } from "../../types/conversation";
import { ChatListPanel } from "./ChatListPanel";

vi.mock("../../services/conversationService", () => ({
  conversationService: {
    list: vi.fn(),
    createDirect: vi.fn(),
  },
}));

function renderChatList() {
  return render(
    <AuthProvider>
      <RealtimeProvider>
        <ConversationsProvider>
          <MemoryRouter>
            <ChatListPanel />
          </MemoryRouter>
        </ConversationsProvider>
      </RealtimeProvider>
    </AuthProvider>
  );
}

const sampleConversation: ConversationSummary = {
  id: "conv-1",
  type: "direct",
  otherParticipant: { id: "user-2", displayName: "Grace Hopper", avatarUrl: null, statusMessage: null },
  lastMessage: { id: "msg-1", body: "See you tomorrow", contentType: "text", senderId: "user-2", createdAt: new Date().toISOString() },
  unreadCount: 3,
  updatedAt: new Date().toISOString(),
};

describe("ChatListPanel", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(conversationService.list).mockReset();
  });

  it("shows an empty state when there are no conversations", async () => {
    seedAuthenticatedSession();
    vi.mocked(conversationService.list).mockResolvedValue([]);

    renderChatList();

    await waitFor(() => expect(screen.getByText("No conversations yet")).toBeInTheDocument());
  });

  it("renders a conversation with its last message preview and unread badge", async () => {
    seedAuthenticatedSession();
    vi.mocked(conversationService.list).mockResolvedValue([sampleConversation]);

    renderChatList();

    await waitFor(() => expect(screen.getByText("Grace Hopper")).toBeInTheDocument());
    expect(screen.getByText("See you tomorrow")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("renders a group with its name, a sender-labelled preview, and media previews", async () => {
    seedAuthenticatedSession();
    const group: ConversationSummary = {
      id: "conv-g1",
      type: "group",
      otherParticipant: null,
      group: { id: "group-1", name: "Book Club", description: null, avatarUrl: null, memberCount: 4, myRole: "member" },
      lastMessage: { id: "msg-7", body: null, contentType: "image", senderId: "user-3", senderDisplayName: "Alan", createdAt: new Date().toISOString() },
      unreadCount: 0,
      updatedAt: new Date().toISOString(),
    };
    vi.mocked(conversationService.list).mockResolvedValue([group, sampleConversation]);

    renderChatList();

    await waitFor(() => expect(screen.getByText("Book Club")).toBeInTheDocument());
    expect(screen.getByLabelText("Group")).toBeInTheDocument();
    expect(screen.getByText("Alan: Photo")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New group" })).toBeInTheDocument();
  });
});
