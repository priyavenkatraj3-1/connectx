import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../../context/AuthContext";
import { ApiError } from "../../services/apiClient";
import { groupService } from "../../services/groupService";
import { seedAuthenticatedSession } from "../../tests/testAuth";
import type { GroupDetails, GroupRole } from "../../types/group";
import { GroupDetailsPanel } from "./GroupDetailsPanel";

vi.mock("../../services/groupService", () => ({
  groupService: { create: vi.fn(), get: vi.fn(), update: vi.fn(), addMembers: vi.fn(), removeMember: vi.fn(), changeRole: vi.fn(), leave: vi.fn() },
}));
vi.mock("../../services/userService", () => ({ userService: { search: vi.fn().mockResolvedValue([]) } }));

const now = new Date().toISOString();

/** The signed-in test user is "user-1"; `myRole` sets their role. */
function makeDetails(myRole: GroupRole): GroupDetails {
  const roles: Record<string, GroupRole> = { "user-1": myRole, owner: "owner", admin: "admin", member: "member" };
  if (myRole === "owner") delete roles.owner;
  if (myRole === "admin") delete roles.admin;
  if (myRole === "member") delete roles.member;
  const names: Record<string, string> = { "user-1": "Test User", owner: "Olivia Owner", admin: "Adam Admin", member: "Mia Member" };
  return {
    group: {
      id: "group-1",
      conversationId: "conv-g1",
      name: "Book Club",
      description: "Monthly reads",
      avatarUrl: null,
      createdBy: "owner",
      createdAt: now,
      updatedAt: now,
      memberCount: Object.keys(roles).length,
      myRole,
    },
    members: Object.entries(roles).map(([userId, role]) => ({
      userId,
      displayName: names[userId]!,
      avatarUrl: null,
      statusMessage: null,
      role,
      joinedAt: now,
      addedBy: null,
    })),
  };
}

function renderPanel(details: GroupDetails, overrides: Partial<Parameters<typeof GroupDetailsPanel>[0]> = {}) {
  const props = { onChange: vi.fn(), onLeft: vi.fn(), onClose: vi.fn(), ...overrides };
  render(
    <AuthProvider>
      <GroupDetailsPanel details={details} {...props} />
    </AuthProvider>
  );
  return props;
}

function memberRow(userId: string) {
  return within(screen.getByTestId(`member-${userId}`));
}

describe("GroupDetailsPanel", () => {
  beforeEach(() => {
    localStorage.clear();
    seedAuthenticatedSession();
    vi.mocked(groupService.changeRole).mockReset();
    vi.mocked(groupService.removeMember).mockReset();
    vi.mocked(groupService.leave).mockReset();
  });

  it("shows group details and every member with their role", () => {
    renderPanel(makeDetails("member"));
    expect(screen.getByText("Book Club")).toBeInTheDocument();
    expect(screen.getByText("Monthly reads")).toBeInTheDocument();
    expect(memberRow("owner").getByText("Owner")).toBeInTheDocument();
    expect(memberRow("admin").getByText("Admin")).toBeInTheDocument();
    expect(memberRow("user-1").getByText("(you)")).toBeInTheDocument();
  });

  it("gives plain members no management controls", () => {
    renderPanel(makeDetails("member"));
    expect(screen.queryByRole("button", { name: "Edit group" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add members" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Remove / })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Make admin" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Leave group" })).toBeInTheDocument();
  });

  it("lets admins edit, add, and remove plain members — but not admins, the owner, or roles", () => {
    renderPanel(makeDetails("admin"));
    expect(screen.getByRole("button", { name: "Edit group" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add members" })).toBeInTheDocument();
    expect(memberRow("member").getByRole("button", { name: "Remove Mia Member" })).toBeInTheDocument();
    expect(memberRow("owner").queryByRole("button", { name: /Remove/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Make admin" })).not.toBeInTheDocument();
  });

  it("lets the owner promote, demote and remove anyone but themselves", async () => {
    const promoted = makeDetails("owner");
    vi.mocked(groupService.changeRole).mockResolvedValue(promoted);
    const user = userEvent.setup();
    const { onChange } = renderPanel(makeDetails("owner"));

    expect(memberRow("admin").getByRole("button", { name: "Remove admin" })).toBeInTheDocument();
    expect(memberRow("admin").getByRole("button", { name: "Remove Adam Admin" })).toBeInTheDocument();
    expect(memberRow("user-1").queryByRole("button")).not.toBeInTheDocument();

    await user.click(memberRow("member").getByRole("button", { name: "Make admin" }));
    await waitFor(() => expect(groupService.changeRole).toHaveBeenCalledWith("test-access-token", "group-1", "member", "admin"));
    expect(onChange).toHaveBeenCalledWith(promoted);
  });

  it("surfaces a server refusal instead of pretending the action worked", async () => {
    vi.mocked(groupService.removeMember).mockRejectedValue(new ApiError("Only the group owner can remove an admin", 403));
    const user = userEvent.setup();
    const { onChange } = renderPanel(makeDetails("owner"));

    await user.click(memberRow("admin").getByRole("button", { name: "Remove Adam Admin" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Only the group owner can remove an admin");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("asks for confirmation before leaving, warning the owner about the hand-over", async () => {
    vi.mocked(groupService.leave).mockResolvedValue({ newOwnerId: "admin" });
    const user = userEvent.setup();
    const { onLeft } = renderPanel(makeDetails("owner"));

    await user.click(screen.getByRole("button", { name: "Leave group" }));
    expect(screen.getByText(/Ownership will pass/)).toBeInTheDocument();
    expect(groupService.leave).not.toHaveBeenCalled();

    const buttons = screen.getAllByRole("button", { name: "Leave group" });
    await user.click(buttons[0]!);
    await waitFor(() => expect(groupService.leave).toHaveBeenCalledWith("test-access-token", "group-1"));
    expect(onLeft).toHaveBeenCalled();
  });

  it("saves edited group details", async () => {
    const updated = makeDetails("admin");
    updated.group.name = "Book Club 2";
    vi.mocked(groupService.update).mockResolvedValue(updated);
    const user = userEvent.setup();
    const { onChange } = renderPanel(makeDetails("admin"));

    await user.click(screen.getByRole("button", { name: "Edit group" }));
    const nameInput = screen.getByLabelText("Name");
    await user.clear(nameInput);
    await user.type(nameInput, "Book Club 2");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(groupService.update).toHaveBeenCalledWith("test-access-token", "group-1", {
        name: "Book Club 2",
        description: "Monthly reads",
        avatarUrl: null,
      })
    );
    expect(onChange).toHaveBeenCalledWith(updated);
  });
});
