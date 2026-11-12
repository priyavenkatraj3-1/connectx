import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../../context/AuthContext";
import { ConversationsProvider } from "../../context/ConversationsContext";
import { RealtimeContext } from "../../context/RealtimeContext";
import { conversationService } from "../../services/conversationService";
import { messageService } from "../../services/messageService";
import { createFakeRealtime } from "../../tests/fakeWebRtc";
import { seedAuthenticatedSession } from "../../tests/testAuth";
import type { ConversationSummary } from "../../types/conversation";
import type { MessageDTO, MessagePage } from "../../types/message";
import { ChatConversationPage } from "./ChatConversationPage";

vi.mock("../../services/conversationService", () => ({ conversationService: { list: vi.fn(), createDirect: vi.fn() } }));
vi.mock("../../services/messageService", () => ({
  messageService: { list: vi.fn(), send: vi.fn(), edit: vi.fn(), remove: vi.fn(), markRead: vi.fn() },
}));

const BASE = Date.parse("2026-01-01T12:00:00Z");

function direct(id: string, otherName: string): ConversationSummary {
  return {
    id,
    type: "direct",
    otherParticipant: { id: `user-${id}`, displayName: otherName, avatarUrl: null, statusMessage: null },
    lastMessage: null,
    unreadCount: 0,
    updatedAt: new Date(BASE).toISOString(),
  };
}

function message(conversationId: string, n: number, body = `${conversationId} message ${n}`): MessageDTO {
  return {
    id: `${conversationId}-m${n}`,
    conversationId,
    senderId: "user-2",
    contentType: "text",
    body,
    status: "sent",
    createdAt: new Date(BASE + n * 1000).toISOString(),
    editedAt: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function SwitchTo({ conversationId }: { conversationId: string }) {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(`/app/chat/${conversationId}`)}>
      Open {conversationId}
    </button>
  );
}

function renderPage(realtime = createFakeRealtime()) {
  render(
    <AuthProvider>
      <RealtimeContext.Provider value={realtime.value}>
        <ConversationsProvider>
          <MemoryRouter initialEntries={["/app/chat/conv-a"]}>
            <SwitchTo conversationId="conv-b" />
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

describe("ChatConversationPage — resync after the socket reconnects", () => {
  beforeEach(() => {
    localStorage.clear();
    seedAuthenticatedSession();
    vi.mocked(messageService.list).mockReset();
    vi.mocked(messageService.markRead).mockResolvedValue(undefined);
    vi.mocked(conversationService.list).mockResolvedValue([direct("conv-a", "Grace Hopper"), direct("conv-b", "Alan Turing")]);
  });

  it("doesn't leave a gap when more than one page arrived while disconnected", async () => {
    vi.mocked(messageService.list).mockResolvedValueOnce({ items: [message("conv-a", 1, "Before the drop")], hasMore: false });
    const realtime = renderPage();
    await screen.findByText("Before the drop");

    // 100 messages arrived meanwhile: the latest page (52–101) no longer reaches the one we have.
    const latestPage = Array.from({ length: 50 }, (_, i) => message("conv-a", 52 + i));
    vi.mocked(messageService.list).mockResolvedValueOnce({ items: latestPage, hasMore: true });
    realtime.reconnect();

    await screen.findByText("conv-a message 101");
    // The old message would sit right above message 52 with messages 2–51 silently missing; it's replaced instead.
    expect(screen.queryByText("Before the drop")).not.toBeInTheDocument();
    expect(screen.getByText("conv-a message 52")).toBeInTheDocument();
  });

  it("keeps older loaded history when the latest page connects to it", async () => {
    const shown = Array.from({ length: 50 }, (_, i) => message("conv-a", 1 + i));
    vi.mocked(messageService.list).mockResolvedValueOnce({ items: shown, hasMore: true });
    const realtime = renderPage();
    await screen.findByText("conv-a message 50");

    // Two new messages: the latest page is messages 3…52, overlapping what's shown.
    const latestPage = Array.from({ length: 50 }, (_, i) => message("conv-a", 3 + i));
    vi.mocked(messageService.list).mockResolvedValueOnce({ items: latestPage, hasMore: true });
    realtime.reconnect();

    await screen.findByText("conv-a message 52");
    expect(screen.getByText("conv-a message 1")).toBeInTheDocument();
    expect(screen.getAllByText("conv-a message 30")).toHaveLength(1);
  });

  it("a resync still in flight for the previous chat can't write into the newly opened chat", async () => {
    vi.mocked(messageService.list).mockResolvedValueOnce({ items: [message("conv-a", 1, "Hello from A")], hasMore: false });
    const realtime = renderPage();
    await screen.findByText("Hello from A");

    const lateResync = deferred<MessagePage>();
    vi.mocked(messageService.list)
      .mockReturnValueOnce(lateResync.promise) // conv-a's resync — still pending when the user switches
      .mockResolvedValueOnce({ items: [message("conv-b", 1, "Hello from B")], hasMore: false });
    realtime.reconnect();
    await userEvent.setup().click(screen.getByRole("button", { name: "Open conv-b" }));
    await screen.findByText("Hello from B");

    lateResync.resolve({ items: [message("conv-a", 1, "Hello from A"), message("conv-a", 2, "Late A message")], hasMore: false });
    await lateResync.promise;
    await new Promise((r) => setTimeout(r, 0));

    expect(screen.getByText("Hello from B")).toBeInTheDocument();
    expect(screen.queryByText("Late A message")).not.toBeInTheDocument();
    expect(screen.queryByText("Hello from A")).not.toBeInTheDocument();
  });
});
