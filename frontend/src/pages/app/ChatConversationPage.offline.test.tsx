import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../../context/AuthContext";
import { ConversationsProvider } from "../../context/ConversationsContext";
import { OfflineProvider } from "../../context/OfflineContext";
import { RealtimeProvider } from "../../context/RealtimeContext";
import { MemoryStore } from "../../lib/offline/storage";
import { NetworkError } from "../../services/apiClient";
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

function setOnline(value: boolean) {
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => value });
}

function renderPage(store: MemoryStore) {
  return render(
    <AuthProvider>
      <RealtimeProvider>
        <OfflineProvider store={store}>
          <ConversationsProvider>
            <MemoryRouter initialEntries={["/app/chat/conv-1"]}>
              <Routes>
                <Route path="/app/chat/:conversationId" element={<ChatConversationPage />} />
              </Routes>
            </MemoryRouter>
          </ConversationsProvider>
        </OfflineProvider>
      </RealtimeProvider>
    </AuthProvider>
  );
}

describe("ChatConversationPage — offline outbox", () => {
  beforeEach(() => {
    localStorage.clear();
    seedAuthenticatedSession();
    vi.mocked(conversationService.list).mockResolvedValue([conversation]);
    vi.mocked(messageService.list).mockResolvedValue({ items: [], hasMore: false });
    vi.mocked(messageService.markRead).mockResolvedValue(undefined);
    vi.mocked(messageService.send).mockReset();
  });

  afterEach(() => setOnline(true));

  it("queues a message written offline, shows it as pending, and sends it exactly once on reconnect", async () => {
    setOnline(false);
    const user = userEvent.setup();
    renderPage(new MemoryStore());
    await screen.findByText("Grace Hopper");

    await user.type(screen.getByLabelText("Message"), "Written on the train{Enter}");
    expect(await screen.findByText("Written on the train")).toBeInTheDocument();
    expect(screen.getByText("Waiting to send")).toBeInTheDocument();
    expect(messageService.send).not.toHaveBeenCalled();

    const sent: MessageDTO = {
      id: "msg-9",
      conversationId: "conv-1",
      senderId: "user-1",
      contentType: "text",
      body: "Written on the train",
      status: "sent",
      createdAt: new Date().toISOString(),
      editedAt: null,
    };
    vi.mocked(messageService.send).mockResolvedValue(sent);
    setOnline(true);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });

    await waitFor(() => expect(screen.queryByText("Waiting to send")).not.toBeInTheDocument());
    expect(screen.getAllByText("Written on the train")).toHaveLength(1);
    expect(messageService.send).toHaveBeenCalledTimes(1);
    const [, , body, extras] = vi.mocked(messageService.send).mock.calls[0]!;
    expect(body).toBe("Written on the train");
    expect(extras?.clientMessageId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("keeps a message pending when the network is still down, and retries with the same key", async () => {
    setOnline(true);
    vi.mocked(messageService.send).mockRejectedValue(new NetworkError("offline", "33333333-3333-4333-8333-333333333333"));
    const user = userEvent.setup();
    renderPage(new MemoryStore());
    await screen.findByText("Grace Hopper");

    await user.type(screen.getByLabelText("Message"), "flaky{Enter}");
    expect(await screen.findByText("Waiting to send")).toBeInTheDocument();
    const keys = vi.mocked(messageService.send).mock.calls.map((call) => call[3]?.clientMessageId).filter(Boolean);
    // Every retry of this message reuses the key from the first (dropped) attempt.
    expect(new Set(keys)).toEqual(new Set(["33333333-3333-4333-8333-333333333333"]));
  });
});
