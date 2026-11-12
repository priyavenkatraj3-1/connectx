import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../../context/AuthContext";
import { ConversationsProvider } from "../../context/ConversationsContext";
import { RealtimeContext } from "../../context/RealtimeContext";
import { ApiError } from "../../services/apiClient";
import { conversationService } from "../../services/conversationService";
import { messageService } from "../../services/messageService";
import { userService } from "../../services/userService";
import { createFakeRealtime } from "../../tests/fakeWebRtc";
import { seedAuthenticatedSession } from "../../tests/testAuth";
import type { ConversationSummary } from "../../types/conversation";
import { ChatConversationPage } from "./ChatConversationPage";

vi.mock("../../services/conversationService", () => ({ conversationService: { list: vi.fn(), createDirect: vi.fn() } }));
vi.mock("../../services/messageService", () => ({
  messageService: { list: vi.fn(), send: vi.fn(), edit: vi.fn(), remove: vi.fn(), markRead: vi.fn() },
}));
vi.mock("../../services/userService", () => ({ userService: { getPublicProfile: vi.fn(), search: vi.fn() } }));

const conversation: ConversationSummary = {
  id: "conv-1",
  type: "direct",
  otherParticipant: { id: "user-2", displayName: "Grace Hopper", avatarUrl: null, statusMessage: "At sea" },
  lastMessage: null,
  unreadCount: 0,
  updatedAt: new Date().toISOString(),
};

function renderPage() {
  render(
    <AuthProvider>
      <RealtimeContext.Provider value={createFakeRealtime().value}>
        <ConversationsProvider>
          <MemoryRouter initialEntries={["/app/chat/conv-1"]}>
            <Routes>
              <Route path="/app/chat/:conversationId" element={<ChatConversationPage />} />
            </Routes>
          </MemoryRouter>
        </ConversationsProvider>
      </RealtimeContext.Provider>
    </AuthProvider>
  );
}

describe("ChatConversationPage — direct chat contact info", () => {
  beforeEach(() => {
    localStorage.clear();
    seedAuthenticatedSession();
    vi.mocked(conversationService.list).mockResolvedValue([conversation]);
    vi.mocked(messageService.list).mockResolvedValue({ items: [], hasMore: false });
    vi.mocked(messageService.markRead).mockResolvedValue(undefined);
    vi.mocked(userService.getPublicProfile).mockReset();
  });

  it("opens from the chat header and shows the profile with bio", async () => {
    vi.mocked(userService.getPublicProfile).mockResolvedValue({
      id: "user-2",
      displayName: "Grace Hopper",
      avatarUrl: null,
      statusMessage: "At sea",
      bio: "Wrote the first compiler.",
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Contact info: Grace Hopper" }));
    const panel = screen.getByRole("complementary", { name: "Contact info" });
    expect(await within(panel).findByText("Wrote the first compiler.")).toBeInTheDocument();
    expect(within(panel).getByText("Grace Hopper")).toBeInTheDocument();
    expect(within(panel).getByText("At sea")).toBeInTheDocument();
    expect(userService.getPublicProfile).toHaveBeenCalledWith("test-access-token", "user-2");

    await user.click(within(panel).getByRole("button", { name: "Close contact info" }));
    expect(screen.queryByRole("complementary", { name: "Contact info" })).not.toBeInTheDocument();
  });

  it("opens from the info button too; without a bio from the server it says so", async () => {
    vi.mocked(userService.getPublicProfile).mockResolvedValue({ id: "user-2", displayName: "Grace Hopper", avatarUrl: null, statusMessage: null });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Contact info" }));
    const panel = screen.getByRole("complementary", { name: "Contact info" });
    expect(await within(panel).findByText("No bio.")).toBeInTheDocument();
  });

  it("keeps showing what the chat list knows when the profile can't be loaded", async () => {
    vi.mocked(userService.getPublicProfile).mockRejectedValue(new ApiError("User not found", 404));
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Contact info" }));
    const panel = screen.getByRole("complementary", { name: "Contact info" });
    expect(await within(panel).findByRole("alert")).toHaveTextContent("User not found");
    expect(within(panel).getByText("Grace Hopper")).toBeInTheDocument();
  });
});
