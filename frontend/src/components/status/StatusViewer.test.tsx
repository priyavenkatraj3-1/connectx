import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../../context/AuthContext";
import { statusService } from "../../services/statusService";
import { seedAuthenticatedSession } from "../../tests/testAuth";
import type { OwnStatusDTO, StatusDTO } from "../../types/status";
import { STATUS_DISPLAY_MS, StatusViewer } from "./StatusViewer";

vi.mock("../../services/statusService", () => ({
  statusService: { viewers: vi.fn() },
}));

function textStatus(id: string, text: string, overrides: Partial<StatusDTO> = {}): StatusDTO {
  return {
    id,
    userId: "user-2",
    type: "text",
    text,
    backgroundColor: "indigo",
    media: null,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    viewedByMe: false,
    ...overrides,
  };
}

function renderViewer(props: Partial<React.ComponentProps<typeof StatusViewer>> = {}) {
  const handlers = { onClose: vi.fn(), onViewed: vi.fn(), onDelete: vi.fn().mockResolvedValue(undefined) };
  render(
    <AuthProvider>
      <StatusViewer
        owner={{ name: "Grace Hopper", avatarUrl: null }}
        statuses={[textStatus("s1", "First"), textStatus("s2", "Second")]}
        isOwn={false}
        {...handlers}
        {...props}
      />
    </AuthProvider>
  );
  return handlers;
}

describe("StatusViewer", () => {
  beforeEach(() => {
    localStorage.clear();
    seedAuthenticatedSession();
  });
  afterEach(() => vi.useRealTimers());

  it("shows statuses in order, reports each first view, and closes after the last", async () => {
    const user = userEvent.setup();
    const { onViewed, onClose } = renderViewer();

    expect(screen.getByText("First")).toBeInTheDocument();
    expect(screen.getByText(/1 of 2/)).toBeInTheDocument();
    expect(onViewed).toHaveBeenCalledWith("s1");

    await user.click(screen.getByRole("button", { name: "Next status" }));
    expect(screen.getByText("Second")).toBeInTheDocument();
    expect(onViewed).toHaveBeenCalledWith("s2");

    await user.click(screen.getByRole("button", { name: "Previous status" }));
    expect(screen.getByText("First")).toBeInTheDocument();
    expect(onViewed).toHaveBeenCalledTimes(2); // not re-reported

    await user.click(screen.getByRole("button", { name: "Next status" }));
    await user.click(screen.getByRole("button", { name: "Next status" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("doesn't re-report statuses already viewed", () => {
    const { onViewed } = renderViewer({ statuses: [textStatus("s1", "Seen", { viewedByMe: true })] });
    expect(onViewed).not.toHaveBeenCalled();
  });

  it("auto-advances text statuses", () => {
    vi.useFakeTimers();
    renderViewer();
    expect(screen.getByText("First")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(STATUS_DISPLAY_MS + 10));
    expect(screen.getByText("Second")).toBeInTheDocument();
  });

  it("never shows the content of a status that has expired", () => {
    renderViewer({ statuses: [textStatus("s1", "Old news", { expiresAt: new Date(Date.now() - 1000).toISOString() })] });
    expect(screen.getByText("This status has expired.")).toBeInTheDocument();
    expect(screen.queryByText("Old news")).not.toBeInTheDocument();
  });

  it("owner view: privacy summary, viewers list and delete", async () => {
    vi.mocked(statusService.viewers).mockResolvedValue([
      { userId: "user-2", displayName: "Grace Hopper", avatarUrl: null, viewedAt: new Date().toISOString() },
    ]);
    const own: OwnStatusDTO = {
      ...textStatus("mine-1", "My update", { userId: "user-1", viewedByMe: true }),
      visibility: "selected",
      audienceUserIds: ["user-2"],
      viewCount: 1,
    };
    const user = userEvent.setup();
    const { onDelete, onViewed } = renderViewer({ statuses: [own], isOwn: true, owner: { name: "Test User", avatarUrl: null } });

    expect(screen.getByText("My status")).toBeInTheDocument();
    expect(screen.getByText("Visible to: Only 1 person")).toBeInTheDocument();
    expect(onViewed).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /Seen by 1/ }));
    await waitFor(() => expect(screen.getByText("Viewed by 1")).toBeInTheDocument());
    expect(screen.getByText("Grace Hopper")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete this status" }));
    expect(onDelete).toHaveBeenCalledWith("mine-1");
  });

  it("doesn't offer owner controls on other people's statuses", () => {
    renderViewer();
    expect(screen.queryByRole("button", { name: /Seen by/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete this status" })).not.toBeInTheDocument();
  });
});
