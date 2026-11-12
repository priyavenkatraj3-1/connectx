import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../../context/AuthContext";
import { ConversationsProvider } from "../../context/ConversationsContext";
import { RealtimeContext } from "../../context/RealtimeContext";
import { conversationService } from "../../services/conversationService";
import { messageService } from "../../services/messageService";
import { createFakeRealtime } from "../../tests/fakeWebRtc";
import { seedAuthenticatedSession } from "../../tests/testAuth";
import type { ConversationSummary } from "../../types/conversation";
import type { MessageDTO } from "../../types/message";
import { ChatConversationPage } from "./ChatConversationPage";

vi.mock("../../services/conversationService", () => ({ conversationService: { list: vi.fn(), createDirect: vi.fn() } }));
vi.mock("../../services/messageService", () => ({
  messageService: { list: vi.fn(), send: vi.fn(), edit: vi.fn(), remove: vi.fn(), markRead: vi.fn(), react: vi.fn() },
}));

const CONV = "11111111-1111-4111-8111-aaaaaaaaaaaa";
const conversation: ConversationSummary = {
  id: CONV,
  type: "direct",
  otherParticipant: { id: "user-2", displayName: "Grace Hopper", avatarUrl: null, statusMessage: null },
  lastMessage: null,
  unreadCount: 0,
  updatedAt: new Date().toISOString(),
};

function renderPage() {
  const realtime = createFakeRealtime();
  render(
    <AuthProvider>
      <RealtimeContext.Provider value={realtime.value}>
        <ConversationsProvider>
          <MemoryRouter initialEntries={[`/app/chat/${CONV}`]}>
            <Routes>
              <Route path="/app/chat/:conversationId" element={<ChatConversationPage />} />
            </Routes>
          </MemoryRouter>
        </ConversationsProvider>
      </RealtimeContext.Provider>
    </AuthProvider>
  );
  return realtime;
}

const message: MessageDTO = {
  id: "m1",
  conversationId: CONV,
  senderId: "user-2",
  contentType: "text",
  body: "Lunch?",
  status: "sent",
  createdAt: new Date().toISOString(),
  editedAt: null,
  reactions: [],
};

describe("ChatConversationPage — reactions", () => {
  beforeEach(() => {
    localStorage.clear();
    seedAuthenticatedSession();
    vi.mocked(conversationService.list).mockResolvedValue([conversation]);
    vi.mocked(messageService.list).mockResolvedValue({ items: [message], hasMore: false });
    vi.mocked(messageService.markRead).mockResolvedValue(undefined);
  });

  it("reacting calls the API and shows the result; others' reactions arrive live", async () => {
    vi.mocked(messageService.react).mockResolvedValue([{ emoji: "👍", count: 1, userIds: ["user-1"] }]);
    const realtime = renderPage();
    const user = userEvent.setup();
    await screen.findByText("Lunch?");

    await user.click(screen.getByRole("button", { name: "Add reaction" }));
    await user.click(within(screen.getByRole("dialog", { name: "Add reaction" })).getByRole("button", { name: "👍" }));
    expect(messageService.react).toHaveBeenCalledWith("test-access-token", CONV, "m1", "👍");
    expect(await screen.findByRole("button", { name: "👍 1 reaction, including yours" })).toBeInTheDocument();

    realtime.emit({
      type: "message:reactions",
      conversationId: CONV,
      messageId: "m1",
      reactions: [{ emoji: "👍", count: 2, userIds: ["user-1", "user-2"] }],
    });
    expect(screen.getByRole("button", { name: "👍 2 reactions, including yours" })).toBeInTheDocument();
  });
});
