import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../../context/AuthContext";
import { CallProvider } from "../../context/CallContext";
import { ConversationsProvider } from "../../context/ConversationsContext";
import { RealtimeContext } from "../../context/RealtimeContext";
import { callService } from "../../services/callService";
import { conversationService } from "../../services/conversationService";
import { messageService } from "../../services/messageService";
import { createFakeMediaDevices, createFakeRealtime, fakePeerFactory, makeCall } from "../../tests/fakeWebRtc";
import { seedAuthenticatedSession } from "../../tests/testAuth";
import type { CallHistoryEntryDTO } from "../../types/call";
import type { ConversationSummary } from "../../types/conversation";
import type { MessageDTO } from "../../types/message";
import { ChatConversationPage } from "./ChatConversationPage";

vi.mock("../../services/conversationService", () => ({
  conversationService: { list: vi.fn(), createDirect: vi.fn() },
}));
vi.mock("../../services/messageService", () => ({
  messageService: { list: vi.fn(), send: vi.fn(), markRead: vi.fn() },
}));
vi.mock("../../services/callService", () => ({
  callService: { history: vi.fn(), active: vi.fn(), start: vi.fn(), end: vi.fn(), iceServers: vi.fn() },
}));

const conversation: ConversationSummary = {
  id: "conv-1",
  type: "direct",
  otherParticipant: { id: "user-2", displayName: "Grace Hopper", avatarUrl: null, statusMessage: null },
  lastMessage: null,
  unreadCount: 0,
  updatedAt: new Date().toISOString(),
};

const t = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

function message(id: string, body: string, minutesAgo: number): MessageDTO {
  return { id, conversationId: "conv-1", senderId: "user-2", contentType: "text", body, status: "read", createdAt: t(minutesAgo), editedAt: null };
}

describe("ChatConversationPage — calls", () => {
  beforeEach(() => {
    localStorage.clear();
    seedAuthenticatedSession();
    vi.mocked(conversationService.list).mockResolvedValue([conversation]);
    vi.mocked(messageService.markRead).mockResolvedValue(undefined);
    vi.mocked(messageService.list).mockResolvedValue({ items: [message("m1", "Before the call", 30), message("m2", "After the call", 5)], hasMore: false });
    const missed: CallHistoryEntryDTO = {
      ...makeCall({ id: "c1", state: "missed", createdAt: t(20), initiatorId: "user-2" }),
      direction: "incoming",
      outcome: "missed",
    };
    vi.mocked(callService.history).mockResolvedValue([missed]);
  });

  it("shows voice/video call buttons and interleaves call history with messages", async () => {
    const realtime = createFakeRealtime();
    render(
      <AuthProvider>
        <RealtimeContext.Provider value={realtime.value}>
          <ConversationsProvider>
            <CallProvider mediaDevices={createFakeMediaDevices()} createPeerConnection={fakePeerFactory}>
              <MemoryRouter initialEntries={["/app/chat/conv-1"]}>
                <Routes>
                  <Route path="/app/chat/:conversationId" element={<ChatConversationPage />} />
                </Routes>
              </MemoryRouter>
            </CallProvider>
          </ConversationsProvider>
        </RealtimeContext.Provider>
      </AuthProvider>
    );

    await waitFor(() => expect(screen.getByTestId("call-history-item")).toHaveTextContent("Missed voice call"));
    expect(screen.getByRole("button", { name: "Start voice call" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Start video call" })).toBeEnabled();
    expect(callService.history).toHaveBeenCalledWith("test-access-token", "conv-1");

    const order = [screen.getByText("Before the call"), screen.getByTestId("call-history-item"), screen.getByText("After the call")];
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });
});
