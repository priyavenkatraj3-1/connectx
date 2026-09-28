import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../../context/AuthContext";
import { ConversationsProvider } from "../../context/ConversationsContext";
import { RealtimeProvider } from "../../context/RealtimeContext";
import { ApiError } from "../../services/apiClient";
import { conversationService } from "../../services/conversationService";
import { groupService } from "../../services/groupService";
import { userService } from "../../services/userService";
import { seedAuthenticatedSession } from "../../tests/testAuth";
import type { GroupDetails } from "../../types/group";
import { NewGroupModal } from "./NewGroupModal";

vi.mock("../../services/conversationService", () => ({ conversationService: { list: vi.fn(), createDirect: vi.fn() } }));
vi.mock("../../services/userService", () => ({ userService: { search: vi.fn(), getMe: vi.fn(), updateMe: vi.fn() } }));
vi.mock("../../services/groupService", () => ({
  groupService: { create: vi.fn(), get: vi.fn(), update: vi.fn(), addMembers: vi.fn(), removeMember: vi.fn(), changeRole: vi.fn(), leave: vi.fn() },
}));

const created: GroupDetails = {
  group: {
    id: "group-1",
    conversationId: "conv-g1",
    name: "Weekend Trip",
    description: null,
    avatarUrl: null,
    createdBy: "user-1",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    memberCount: 2,
    myRole: "owner",
  },
  members: [],
};

function renderModal(onClose = vi.fn()) {
  render(
    <AuthProvider>
      <RealtimeProvider>
        <ConversationsProvider>
          <MemoryRouter initialEntries={["/app"]}>
            <Routes>
              <Route path="/app" element={<NewGroupModal onClose={onClose} />} />
              <Route path="/app/chat/:conversationId" element={<p>Opened group chat</p>} />
            </Routes>
          </MemoryRouter>
        </ConversationsProvider>
      </RealtimeProvider>
    </AuthProvider>
  );
  return onClose;
}

describe("NewGroupModal", () => {
  beforeEach(() => {
    localStorage.clear();
    seedAuthenticatedSession();
    vi.mocked(conversationService.list).mockResolvedValue([]);
    vi.mocked(userService.search).mockResolvedValue([
      { id: "user-2", displayName: "Grace Hopper", avatarUrl: null, statusMessage: null },
      { id: "user-3", displayName: "Alan Turing", avatarUrl: null, statusMessage: null },
    ]);
    vi.mocked(groupService.create).mockReset();
  });

  it("requires a name and at least one member before creating", async () => {
    const user = userEvent.setup();
    renderModal();
    const create = screen.getByRole("button", { name: "Create group" });
    expect(create).toBeDisabled();

    await user.type(screen.getByLabelText("Group name"), "Weekend Trip");
    expect(create).toBeDisabled();

    await user.type(screen.getByPlaceholderText("Search by name or email"), "gr");
    await user.click(await screen.findByRole("checkbox", { name: /Grace Hopper/ }));
    expect(create).toBeEnabled();
  });

  it("creates the group with the selected members and opens it", async () => {
    vi.mocked(groupService.create).mockResolvedValue(created);
    const user = userEvent.setup();
    const onClose = renderModal();

    await user.type(screen.getByLabelText("Group name"), "  Weekend Trip ");
    await user.type(screen.getByLabelText(/Description/), "Planning");
    await user.type(screen.getByPlaceholderText("Search by name or email"), "a");
    await user.click(await screen.findByRole("checkbox", { name: /Grace Hopper/ }));
    await user.click(screen.getByRole("checkbox", { name: /Alan Turing/ }));
    expect(screen.getByText("(2 selected)")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Create group" }));

    await waitFor(() =>
      expect(groupService.create).toHaveBeenCalledWith("test-access-token", {
        name: "Weekend Trip",
        description: "Planning",
        memberIds: ["user-2", "user-3"],
      })
    );
    expect(await screen.findByText("Opened group chat")).toBeInTheDocument();
    expect(onClose).toHaveBeenCalled();
  });

  it("lets you deselect someone via their chip", async () => {
    const user = userEvent.setup();
    renderModal();
    await user.type(screen.getByPlaceholderText("Search by name or email"), "gr");
    await user.click(await screen.findByRole("checkbox", { name: /Grace Hopper/ }));
    await user.click(screen.getByRole("button", { name: "Remove Grace Hopper" }));
    expect(screen.getByText("(0 selected)")).toBeInTheDocument();
  });

  it("shows the server's validation error and stays open", async () => {
    vi.mocked(groupService.create).mockRejectedValue(new ApiError("Unknown or inactive users: user-2", 400));
    const user = userEvent.setup();
    const onClose = renderModal();

    await user.type(screen.getByLabelText("Group name"), "Oops");
    await user.type(screen.getByPlaceholderText("Search by name or email"), "gr");
    await user.click(await screen.findByRole("checkbox", { name: /Grace Hopper/ }));
    await user.click(screen.getByRole("button", { name: "Create group" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Unknown or inactive users");
    expect(onClose).not.toHaveBeenCalled();
  });
});
