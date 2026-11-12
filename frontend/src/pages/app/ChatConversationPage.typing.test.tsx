import { render, screen, waitFor } from "@testing-library/react";
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
  messageService: { list: vi.fn(), send: vi.fn(), edit: vi.fn(), remove: vi.fn(), markRead: vi.fn() },
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

const typingSent = (realtime: ReturnType<typeof createFakeRealtime>) =>
  realtime.sent.flatMap((e) => (e.type === "typing" ? [e.isTyping] : []));

describe("ChatConversationPage — typing indicator", () => {
  beforeEach(() => {
    localStorage.clear();
    seedAuthenticatedSession();
    vi.mocked(conversationService.list).mockResolvedValue([conversation]);
    vi.mocked(messageService.list).mockResolvedValue({ items: [], hasMore: false });
    vi.mocked(messageService.markRead).mockResolvedValue(undefined);
  });

  it("tells the other person while you type, and stops when the message is sent", async () => {
    const sent: MessageDTO = {
      id: "m1",
      conversationId: CONV,
      senderId: "user-1",
      contentType: "text",
      body: "Hello",
      status: "sent",
      createdAt: new Date().toISOString(),
      editedAt: null,
    };
    vi.mocked(messageService.send).mockResolvedValue(sent);
    const realtime = renderPage();
    const user = userEvent.setup();

    await user.type(await screen.findByPlaceholderText(/message/i), "Hello");
    expect(typingSent(realtime)).toEqual([true]);

    await user.keyboard("{Enter}");
    await waitFor(() => expect(typingSent(realtime)).toEqual([true, false]));
  });

  it("shows when the other person is typing, and hides it when they stop", async () => {
    const realtime = renderPage();
    await screen.findByPlaceholderText(/message/i);

    realtime.emit({ type: "typing", conversationId: CONV, userId: "user-2", isTyping: true });
    expect(screen.getByText("Grace Hopper is typing…")).toBeInTheDocument();

    realtime.emit({ type: "typing", conversationId: CONV, userId: "user-2", isTyping: false });
    expect(screen.queryByText("Grace Hopper is typing…")).not.toBeInTheDocument();
  });
});
