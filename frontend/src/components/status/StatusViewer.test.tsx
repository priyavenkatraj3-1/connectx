import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../../context/AuthContext";
import { RealtimeContext } from "../../context/RealtimeContext";
import { statusService } from "../../services/statusService";
import { createFakeRealtime } from "../../tests/fakeWebRtc";
import { seedAuthenticatedSession } from "../../tests/testAuth";
import type { OwnStatusDTO, StatusDTO } from "../../types/status";
import { mergeViewers, STATUS_DISPLAY_MS, StatusViewer } from "./StatusViewer";

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

  it("owner view: the open viewers list updates live when someone views the status", async () => {
    vi.mocked(statusService.viewers).mockResolvedValue([
      { userId: "user-2", displayName: "Grace Hopper", avatarUrl: null, viewedAt: new Date().toISOString() },
    ]);
    const own: OwnStatusDTO = {
      ...textStatus("mine-1", "My update", { userId: "user-1", viewedByMe: true }),
      visibility: "contacts",
      audienceUserIds: [],
      viewCount: 1,
    };
    const realtime = createFakeRealtime();
    const user = userEvent.setup();
    render(
      <AuthProvider>
        <RealtimeContext.Provider value={realtime.value}>
          <StatusViewer owner={{ name: "Test User", avatarUrl: null }} statuses={[own]} isOwn onClose={vi.fn()} />
        </RealtimeContext.Provider>
      </AuthProvider>
    );

    await user.click(screen.getByRole("button", { name: /Seen by 1/ }));
    await waitFor(() => expect(screen.getByText("Viewed by 1")).toBeInTheDocument());

    const viewer = { userId: "user-3", displayName: "Ada Lovelace", avatarUrl: null };
    realtime.emit({ type: "status:viewed", statusId: "mine-1", viewer, viewedAt: new Date().toISOString(), viewCount: 2 });
    expect(screen.getByText("Viewed by 2")).toBeInTheDocument();
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();

    // A repeated event or one for another status doesn't change the list.
    realtime.emit({ type: "status:viewed", statusId: "mine-1", viewer, viewedAt: new Date().toISOString(), viewCount: 2 });
    realtime.emit({ type: "status:viewed", statusId: "other", viewer: { ...viewer, userId: "user-4" }, viewedAt: new Date().toISOString(), viewCount: 1 });
    expect(screen.getByText("Viewed by 2")).toBeInTheDocument();
  });

  it("owner view: a view reported before the viewer list loads isn't lost or duplicated", async () => {
    let respond!: (viewers: Awaited<ReturnType<typeof statusService.viewers>>) => void;
    vi.mocked(statusService.viewers).mockReturnValue(new Promise((resolve) => (respond = resolve)));
    const own: OwnStatusDTO = {
      ...textStatus("mine-1", "My update", { userId: "user-1", viewedByMe: true }),
      visibility: "contacts",
      audienceUserIds: [],
      viewCount: 1,
    };
    const realtime = createFakeRealtime();
    const user = userEvent.setup();
    render(
      <AuthProvider>
        <RealtimeContext.Provider value={realtime.value}>
          <StatusViewer owner={{ name: "Test User", avatarUrl: null }} statuses={[own]} isOwn onClose={vi.fn()} />
        </RealtimeContext.Provider>
      </AuthProvider>
    );
    await user.click(screen.getByRole("button", { name: /Seen by 1/ }));
    expect(screen.getByText("Viewed by …")).toBeInTheDocument();

    const t0 = Date.now();
    const ada = { userId: "user-3", displayName: "Ada Lovelace", avatarUrl: null };
    const grace = { userId: "user-2", displayName: "Grace Hopper", avatarUrl: null };
    // Both arrive while the list request is still pending; Grace's view is also in the response.
    realtime.emit({ type: "status:viewed", statusId: "mine-1", viewer: ada, viewedAt: new Date(t0 + 2000).toISOString(), viewCount: 2 });
    realtime.emit({ type: "status:viewed", statusId: "mine-1", viewer: grace, viewedAt: new Date(t0 + 1000).toISOString(), viewCount: 2 });
    await act(async () => respond([{ ...grace, viewedAt: new Date(t0 + 1000).toISOString() }]));

    expect(screen.getByText("Viewed by 2")).toBeInTheDocument();
    expect(screen.getAllByText("Grace Hopper")).toHaveLength(1);
    const names = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(names[0]).toContain("Ada Lovelace"); // newest first
    expect(names[1]).toContain("Grace Hopper");
  });

  it("replies to someone's status, pausing auto-advance while typing and keeping arrow keys in the box", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onReply = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { onClose } = renderViewer({ onReply });

    const box = screen.getByRole("textbox", { name: "Reply to Grace Hopper" });
    await user.click(box);
    await user.type(box, "So cool{ArrowLeft}{ArrowRight}");
    act(() => vi.advanceTimersByTime(STATUS_DISPLAY_MS * 2));
    expect(screen.getByText("First")).toBeInTheDocument(); // still on the first status
    expect(onClose).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(onReply).toHaveBeenCalledWith("s1", "So cool");
    expect(await screen.findByRole("status")).toHaveTextContent("Reply sent — it's in your chat with Grace Hopper.");
    expect(box).toHaveValue("");
  });

  it("shows why a reply failed and keeps the text", async () => {
    const onReply = vi.fn().mockRejectedValue(new Error("Status not found"));
    const user = userEvent.setup();
    renderViewer({ onReply });
    const box = screen.getByRole("textbox", { name: "Reply to Grace Hopper" });
    await user.type(box, "hello");
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Status not found");
    expect(box).toHaveValue("hello");
  });

  it("has no reply box on your own status or without a reply handler", () => {
    const own: OwnStatusDTO = {
      ...textStatus("mine-1", "My update", { userId: "user-1", viewedByMe: true }),
      visibility: "contacts",
      audienceUserIds: [],
      viewCount: 0,
    };
    renderViewer({ statuses: [own], isOwn: true, onReply: vi.fn() });
    expect(screen.queryByRole("textbox", { name: /Reply to/ })).not.toBeInTheDocument();
    cleanup();
    renderViewer();
    expect(screen.queryByRole("textbox", { name: /Reply to/ })).not.toBeInTheDocument();
  });

  it("doesn't offer owner controls on other people's statuses", () => {
    renderViewer();
    expect(screen.queryByRole("button", { name: /Seen by/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete this status" })).not.toBeInTheDocument();
  });
});

describe("mergeViewers", () => {
  it("keeps one entry per user (the fetched copy), newest first", () => {
    const at = (s: number) => new Date(Date.parse("2026-01-01T12:00:00Z") + s * 1000).toISOString();
    const merged = mergeViewers(
      [{ userId: "u1", displayName: "Fetched One", avatarUrl: null, viewedAt: at(1) }],
      [
        { userId: "u1", displayName: "Live One", avatarUrl: null, viewedAt: at(1) },
        { userId: "u2", displayName: "Two", avatarUrl: null, viewedAt: at(5) },
        { userId: "u2", displayName: "Two", avatarUrl: null, viewedAt: at(5) },
      ]
    );
    expect(merged.map((v) => v.displayName)).toEqual(["Two", "Fetched One"]);
  });
});
