import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../../context/AuthContext";
import { ConversationsProvider } from "../../context/ConversationsContext";
import { RealtimeProvider } from "../../context/RealtimeContext";
import { conversationService } from "../../services/conversationService";
import { userService } from "../../services/userService";
import { seedAuthenticatedSession } from "../../tests/testAuth";
import type { PublicProfile } from "../../types/user";
import { NewConversationModal } from "./NewConversationModal";

vi.mock("../../services/conversationService", () => ({
  conversationService: { list: vi.fn(), createDirect: vi.fn() },
}));
vi.mock("../../services/userService", () => ({
  userService: { search: vi.fn() },
}));

const grace: PublicProfile = { id: "user-2", displayName: "Grace Hopper", avatarUrl: null, statusMessage: null };

function renderModal(onClose = vi.fn()) {
  return render(
    <AuthProvider>
      <RealtimeProvider>
        <ConversationsProvider>
          <MemoryRouter initialEntries={["/app"]}>
            <Routes>
              <Route path="/app" element={<NewConversationModal onClose={onClose} />} />
              <Route path="/app/chat/:conversationId" element={<div>Conversation view for chat</div>} />
            </Routes>
          </MemoryRouter>
        </ConversationsProvider>
      </RealtimeProvider>
    </AuthProvider>
  );
}

describe("NewConversationModal", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(conversationService.list).mockResolvedValue([]);
    vi.mocked(userService.search).mockReset();
  });

  it("searches for a user and starts a conversation when one is selected", async () => {
    seedAuthenticatedSession();
    vi.mocked(userService.search).mockResolvedValue([grace]);
    vi.mocked(conversationService.createDirect).mockResolvedValue({ id: "conv-99" });

    renderModal();

    await userEvent.type(screen.getByPlaceholderText("Search by name or email"), "grace");

    await waitFor(() => expect(screen.getByText("Grace Hopper")).toBeInTheDocument(), { timeout: 2000 });

    await userEvent.click(screen.getByText("Grace Hopper"));

    await waitFor(() => expect(conversationService.createDirect).toHaveBeenCalledWith("test-access-token", "user-2"));
    await waitFor(() => expect(screen.getByText("Conversation view for chat")).toBeInTheDocument());
  });

  it("shows a message when no one matches the search", async () => {
    seedAuthenticatedSession();
    vi.mocked(userService.search).mockResolvedValue([]);

    renderModal();

    await userEvent.type(screen.getByPlaceholderText("Search by name or email"), "nobody");

    await waitFor(() => expect(screen.getByText(/No one found matching/)).toBeInTheDocument(), { timeout: 2000 });
  });
});
