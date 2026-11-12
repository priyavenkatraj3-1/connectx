import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../../context/AuthContext";
import { ConversationsProvider } from "../../context/ConversationsContext";
import { RealtimeContext, RealtimeProvider } from "../../context/RealtimeContext";
import { conversationService } from "../../services/conversationService";
import { groupService } from "../../services/groupService";
import { messageService } from "../../services/messageService";
import { createFakeRealtime } from "../../tests/fakeWebRtc";
import { seedAuthenticatedSession } from "../../tests/testAuth";
import type { ConversationSummary } from "../../types/conversation";
import type { GroupDetails } from "../../types/group";
import type { MessageDTO } from "../../types/message";
import { ChatConversationPage } from "./ChatConversationPage";

vi.mock("../../services/conversationService", () => ({ conversationService: { list: vi.fn(), createDirect: vi.fn() } }));
vi.mock("../../services/messageService", () => ({
  messageService: { list: vi.fn(), send: vi.fn(), edit: vi.fn(), remove: vi.fn(), markRead: vi.fn() },
}));
vi.mock("../../services/groupService", () => ({
  groupService: { create: vi.fn(), get: vi.fn(), update: vi.fn(), addMembers: vi.fn(), removeMember: vi.fn(), changeRole: vi.fn(), leave: vi.fn() },
}));

const now = new Date().toISOString();

const groupConversation: ConversationSummary = {
  id: "conv-g1",
  type: "group",
  otherParticipant: null,
  group: { id: "group-1", name: "Book Club", description: null, avatarUrl: null, memberCount: 3, myRole: "member" },
  lastMessage: null,
  unreadCount: 0,
  updatedAt: now,
};

const details: GroupDetails = {
  group: {
    id: "group-1",
    conversationId: "conv-g1",
    name: "Book Club",
    description: null,
    avatarUrl: null,
    createdBy: "user-2",
    createdAt: now,
    updatedAt: now,
    memberCount: 3,
    myRole: "member",
  },
  members: [
    { userId: "user-2", displayName: "Grace Hopper", avatarUrl: null, statusMessage: null, role: "owner", joinedAt: now, addedBy: null },
    { userId: "user-3", displayName: "Alan Turing", avatarUrl: null, statusMessage: null, role: "member", joinedAt: now, addedBy: "user-2" },
    { userId: "user-1", displayName: "Test User", avatarUrl: null, statusMessage: null, role: "member", joinedAt: now, addedBy: "user-2" },
  ],
};

const messages: MessageDTO[] = [
  {
    id: "m1",
    conversationId: "conv-g1",
    senderId: "user-2",
    sender: { id: "user-2", displayName: "Grace Hopper", avatarUrl: null },
    contentType: "text",
    body: "Chapter 3 tonight?",
    status: "sent",
    createdAt: now,
    editedAt: null,
    replyTo: null,
    mentions: [],
    attachment: null,
  },
  {
    id: "m2",
    conversationId: "conv-g1",
    senderId: "user-1",
    sender: { id: "user-1", displayName: "Test User", avatarUrl: null },
    contentType: "text",
    body: "Works for me",
    status: "read",
    createdAt: now,
    editedAt: null,
    replyTo: null,
    mentions: [],
    attachment: null,
  },
];

function renderPage() {
  return render(
    <AuthProvider>
      <RealtimeProvider>
        <ConversationsProvider>
          <MemoryRouter initialEntries={["/app/chat/conv-g1"]}>
            <Routes>
              <Route path="/app/chat/:conversationId" element={<ChatConversationPage />} />
              <Route path="/app" element={<p>Chat list</p>} />
            </Routes>
          </MemoryRouter>
        </ConversationsProvider>
      </RealtimeProvider>
    </AuthProvider>
  );
}

describe("ChatConversationPage — groups", () => {
  beforeEach(() => {
    localStorage.clear();
    seedAuthenticatedSession();
    vi.mocked(conversationService.list).mockResolvedValue([groupConversation]);
    vi.mocked(messageService.list).mockResolvedValue({ items: messages, hasMore: false });
    vi.mocked(messageService.markRead).mockResolvedValue(undefined);
    vi.mocked(groupService.get).mockResolvedValue(details);
  });

  it("shows the group name, member count and each sender's name", async () => {
    renderPage();

    await waitFor(() => expect(screen.getByText("Chapter 3 tonight?")).toBeInTheDocument());
    expect(screen.getByText("Book Club")).toBeInTheDocument();
    expect(screen.getByText("3 members")).toBeInTheDocument();
    // Others' messages are labelled with the sender; your own aren't.
    expect(screen.getByText("Grace Hopper")).toBeInTheDocument();
    expect(screen.queryByText("Test User")).not.toBeInTheDocument();
  });

  it("after the socket reconnects, refetches the chat list and picks up messages missed while offline", async () => {
    const realtime = createFakeRealtime();
    render(
      <AuthProvider>
        <RealtimeContext.Provider value={realtime.value}>
          <ConversationsProvider>
            <MemoryRouter initialEntries={["/app/chat/conv-g1"]}>
              <Routes>
                <Route path="/app/chat/:conversationId" element={<ChatConversationPage />} />
              </Routes>
            </MemoryRouter>
          </ConversationsProvider>
        </RealtimeContext.Provider>
      </AuthProvider>
    );
    await waitFor(() => expect(screen.getByText("Chapter 3 tonight?")).toBeInTheDocument());
    const listCalls = vi.mocked(conversationService.list).mock.calls.length;

    const missed: MessageDTO = { ...messages[0]!, id: "m3", body: "Sent while you were disconnected", createdAt: new Date(Date.now() + 1000).toISOString() };
    vi.mocked(messageService.list).mockResolvedValue({ items: [...messages, missed], hasMore: false });
    realtime.reconnect();

    await waitFor(() => expect(screen.getByText("Sent while you were disconnected")).toBeInTheDocument());
    expect(screen.getAllByText("Chapter 3 tonight?")).toHaveLength(1);
    expect(vi.mocked(conversationService.list).mock.calls.length).toBeGreaterThan(listCalls);
  });

  it("offers voice recording to group members, and takes it away once you're removed", async () => {
    const realtime = createFakeRealtime();
    render(
      <AuthProvider>
        <RealtimeContext.Provider value={realtime.value}>
          <ConversationsProvider>
            <MemoryRouter initialEntries={["/app/chat/conv-g1"]}>
              <Routes>
                <Route path="/app/chat/:conversationId" element={<ChatConversationPage />} />
              </Routes>
            </MemoryRouter>
          </ConversationsProvider>
        </RealtimeContext.Provider>
      </AuthProvider>
    );
    await waitFor(() => expect(screen.getByText("Chapter 3 tonight?")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Record voice message" })).toBeInTheDocument();

    realtime.emit({ type: "conversation:removed", conversationId: "conv-g1", reason: "removed" });
    expect(await screen.findByText(/You were removed from this group/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Record voice message" })).not.toBeInTheDocument();
  });

  it("marks the chat read once per new latest message, not on every receipt update", async () => {
    vi.mocked(messageService.markRead).mockClear();
    const realtime = createFakeRealtime();
    render(
      <AuthProvider>
        <RealtimeContext.Provider value={realtime.value}>
          <ConversationsProvider>
            <MemoryRouter initialEntries={["/app/chat/conv-g1"]}>
              <Routes>
                <Route path="/app/chat/:conversationId" element={<ChatConversationPage />} />
              </Routes>
            </MemoryRouter>
          </ConversationsProvider>
        </RealtimeContext.Provider>
      </AuthProvider>
    );
    await waitFor(() => expect(messageService.markRead).toHaveBeenCalledWith("test-access-token", "conv-g1", "m2"));
    expect(messageService.markRead).toHaveBeenCalledTimes(1);
    vi.mocked(messageService.markRead).mockClear();

    realtime.emit({ type: "message:status", conversationId: "conv-g1", messageIds: ["m2"], status: "delivered" });
    realtime.emit({ type: "message:read", conversationId: "conv-g1", userId: "user-2", upToMessageId: "m2" });
    expect(messageService.markRead).not.toHaveBeenCalled();

    realtime.emit({ type: "message:new", conversationId: "conv-g1", message: { ...messages[0]!, id: "m4", body: "New one" } });
    await waitFor(() => expect(messageService.markRead).toHaveBeenCalledWith("test-access-token", "conv-g1", "m4"));
    expect(messageService.markRead).toHaveBeenCalledTimes(1);
  });

  it("opens the group info panel with the member list", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Group info" }));
    const panel = screen.getByRole("complementary", { name: "Group details" });
    expect(panel).toHaveTextContent("Alan Turing");
    expect(panel).toHaveTextContent("Owner");
  });

  it("offers group members as @mention suggestions, excluding yourself", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("button", { name: "Group info" }); // group details loaded

    await user.type(screen.getByLabelText("Message"), "@");
    expect(await screen.findByRole("option", { name: "@Grace Hopper" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "@Alan Turing" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "@Test User" })).not.toBeInTheDocument();
  });

  it("returns to the chat list after leaving the group", async () => {
    vi.mocked(groupService.leave).mockResolvedValue({ newOwnerId: null });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Group info" }));
    await user.click(screen.getByRole("button", { name: "Leave group" }));
    await user.click(screen.getAllByRole("button", { name: "Leave group" })[0]!);

    expect(await screen.findByText("Chat list")).toBeInTheDocument();
  });
});
