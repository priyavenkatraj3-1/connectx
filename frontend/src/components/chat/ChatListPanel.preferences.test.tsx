import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../../context/AuthContext";
import { ConversationsProvider, useConversations } from "../../context/ConversationsContext";
import { RealtimeContext } from "../../context/RealtimeContext";
import { ApiError } from "../../services/apiClient";
import { conversationService } from "../../services/conversationService";
import { createFakeRealtime } from "../../tests/fakeWebRtc";
import { seedAuthenticatedSession } from "../../tests/testAuth";
import type { ConversationSummary } from "../../types/conversation";
import { ChatListPanel } from "./ChatListPanel";

vi.mock("../../services/conversationService", () => ({
  conversationService: { list: vi.fn(), createDirect: vi.fn(), updatePreferences: vi.fn() },
}));

const hourFromNow = () => new Date(Date.now() + 3_600_000).toISOString();

function chat(id: string, name: string, overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id,
    type: "direct",
    otherParticipant: { id: `user-${id}`, displayName: name, avatarUrl: null, statusMessage: null },
    lastMessage: null,
    unreadCount: 0,
    updatedAt: new Date().toISOString(),
    pinned: false,
    archived: false,
    mutedUntil: null,
    ...overrides,
  };
}

function UnreadTotal() {
  return <p data-testid="total">{useConversations().totalUnreadCount}</p>;
}

function renderList() {
  const realtime = createFakeRealtime();
  render(
    <AuthProvider>
      <RealtimeContext.Provider value={realtime.value}>
        <ConversationsProvider>
          <MemoryRouter>
            <ChatListPanel />
            <UnreadTotal />
          </MemoryRouter>
        </ConversationsProvider>
      </RealtimeContext.Provider>
    </AuthProvider>
  );
  return realtime;
}

/** Chat names in the order the list shows them. */
const rowNames = () => screen.getAllByRole("link").map((link) => within(link).getByText(/^(Ada|Bob|Cy|Dee)$/).textContent);

describe("ChatListPanel — pin, archive, mute", () => {
  beforeEach(() => {
    localStorage.clear();
    seedAuthenticatedSession();
    vi.mocked(conversationService.updatePreferences).mockReset();
    vi.mocked(conversationService.list).mockResolvedValue([
      chat("c1", "Ada", { unreadCount: 2 }),
      chat("c2", "Bob", { pinned: true }),
      chat("c3", "Cy", { archived: true, unreadCount: 5 }),
      chat("c4", "Dee", { mutedUntil: hourFromNow(), unreadCount: 4 }),
    ]);
  });

  it("puts pinned chats first, hides archived ones in their own view, and marks muted chats", async () => {
    renderList();
    await screen.findByText("Ada");
    expect(rowNames()).toEqual(["Bob", "Ada", "Dee"]);
    expect(screen.getByLabelText("Pinned")).toBeInTheDocument();
    expect(screen.getByLabelText(/^Muted until/)).toBeInTheDocument();
    // Muted (Dee: 4) and archived (Cy: 5) chats don't add to the total — only Ada's 2 do.
    expect(screen.getByTestId("total")).toHaveTextContent("2");

    await userEvent.setup().click(screen.getByRole("button", { name: "Archived (1)" }));
    expect(rowNames()).toEqual(["Cy"]);
    await userEvent.setup().click(screen.getByRole("button", { name: "← Back to chats" }));
    expect(rowNames()).toEqual(["Bob", "Ada", "Dee"]);
  });

  it("pins and mutes from the row menu, and opens it with a right-click too", async () => {
    vi.mocked(conversationService.updatePreferences)
      .mockResolvedValueOnce({ pinned: true, archived: false, mutedUntil: null })
      .mockResolvedValueOnce({ pinned: true, archived: false, mutedUntil: "9999-12-31T00:00:00.000Z" });
    const user = userEvent.setup();
    renderList();
    await screen.findByText("Ada");

    await user.click(screen.getByRole("button", { name: "Chat options for Ada" }));
    await user.click(within(screen.getByRole("menu", { name: "Chat options for Ada" })).getByRole("menuitem", { name: "Pin chat" }));
    expect(conversationService.updatePreferences).toHaveBeenCalledWith("test-access-token", "c1", { pinned: true });
    expect(rowNames()).toEqual(["Ada", "Bob", "Dee"]);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    fireEvent.contextMenu(screen.getByText("Ada"));
    await user.click(screen.getByRole("menuitem", { name: "Mute until I unmute" }));
    expect(conversationService.updatePreferences).toHaveBeenLastCalledWith("test-access-token", "c1", { mute: "always" });
    expect(screen.getByTestId("total")).toHaveTextContent("0");
    expect(screen.getAllByLabelText("Muted")).toHaveLength(1);
  });

  it("shows the server's refusal (e.g. the pin limit) in the menu and keeps it open", async () => {
    vi.mocked(conversationService.updatePreferences).mockRejectedValue(new ApiError("You can pin up to 5 chats", 400));
    const user = userEvent.setup();
    renderList();
    await screen.findByText("Ada");

    await user.click(screen.getByRole("button", { name: "Chat options for Ada" }));
    await user.click(screen.getByRole("menuitem", { name: "Pin chat" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You can pin up to 5 chats");
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(rowNames()).toEqual(["Bob", "Ada", "Dee"]);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("applies changes made on another device", async () => {
    const realtime = renderList();
    await screen.findByText("Ada");
    realtime.emit({ type: "conversation:preferences", conversationId: "c1", pinned: false, archived: true, mutedUntil: null });
    expect(rowNames()).toEqual(["Bob", "Dee"]);
    expect(screen.getByRole("button", { name: "Archived (2)" })).toBeInTheDocument();
  });
});
