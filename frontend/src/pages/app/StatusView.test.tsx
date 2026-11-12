import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../../context/AuthContext";
import { RealtimeContext } from "../../context/RealtimeContext";
import { statusService } from "../../services/statusService";
import { createFakeRealtime } from "../../tests/fakeWebRtc";
import { seedAuthenticatedSession } from "../../tests/testAuth";
import type { StatusDTO, StatusListResponse } from "../../types/status";
import { StatusView } from "./StatusView";

vi.mock("../../services/statusService", () => ({
  statusService: { list: vi.fn(), markViewed: vi.fn(), remove: vi.fn(), getPrivacy: vi.fn(), viewers: vi.fn() },
}));

const hour = 3_600_000;

function status(id: string, userId: string, text: string, overrides: Partial<StatusDTO> = {}): StatusDTO {
  return {
    id,
    userId,
    type: "text",
    text,
    backgroundColor: "indigo",
    media: null,
    createdAt: new Date(Date.now() - hour).toISOString(),
    expiresAt: new Date(Date.now() + hour).toISOString(),
    viewedByMe: false,
    ...overrides,
  };
}

const listResponse: StatusListResponse = {
  mine: [],
  feed: [
    {
      user: { id: "user-2", displayName: "Grace Hopper", avatarUrl: null, statusMessage: null },
      statuses: [status("g1", "user-2", "Grace's update")],
      hasUnseen: true,
      latestAt: new Date().toISOString(),
    },
    {
      user: { id: "user-3", displayName: "Alan Turing", avatarUrl: null, statusMessage: null },
      statuses: [status("a1", "user-3", "Alan's update", { viewedByMe: true })],
      hasUnseen: false,
      latestAt: new Date().toISOString(),
    },
    {
      // The server stops returning expired statuses; if one slips through (clock skew, a stale list) the UI drops it too.
      user: { id: "user-4", displayName: "Old Timer", avatarUrl: null, statusMessage: null },
      statuses: [status("o1", "user-4", "stale", { expiresAt: new Date(Date.now() - 1000).toISOString() })],
      hasUnseen: true,
      latestAt: new Date().toISOString(),
    },
  ],
};

function renderView() {
  const realtime = createFakeRealtime();
  render(
    <AuthProvider>
      <RealtimeContext.Provider value={realtime.value}>
        <StatusView />
      </RealtimeContext.Provider>
    </AuthProvider>
  );
  return realtime;
}

describe("StatusView", () => {
  beforeEach(() => {
    localStorage.clear();
    seedAuthenticatedSession();
    vi.mocked(statusService.list).mockReset().mockResolvedValue(structuredClone(listResponse));
    vi.mocked(statusService.markViewed).mockReset().mockResolvedValue(undefined);
  });

  it("groups updates into recent and viewed, and hides expired ones", async () => {
    renderView();
    const recent = await screen.findByRole("region", { name: "Recent updates" });
    expect(within(recent).getByText("Grace Hopper")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Viewed updates" })).getByText("Alan Turing")).toBeInTheDocument();
    expect(screen.queryByText("Old Timer")).not.toBeInTheDocument();
    expect(screen.getByText("Share a photo, video or text for 24 hours")).toBeInTheDocument();
  });

  it("opens a status and marks it viewed", async () => {
    const user = userEvent.setup();
    renderView();
    await user.click(await screen.findByRole("button", { name: /Grace Hopper/ }));
    expect(screen.getByRole("dialog", { name: "Grace Hopper's status" })).toHaveTextContent("Grace's update");
    await waitFor(() => expect(statusService.markViewed).toHaveBeenCalledWith("test-access-token", "g1"));
  });

  it("reacts to realtime updates: new statuses refetch, deleted ones disappear", async () => {
    const realtime = renderView();
    await screen.findByText("Grace Hopper");

    realtime.emit({ type: "status:deleted", statusId: "g1", userId: "user-2" });
    expect(screen.queryByText("Grace Hopper")).not.toBeInTheDocument();

    realtime.emit({ type: "status:created", statusId: "new", userId: "user-2" });
    await waitFor(() => expect(statusService.list).toHaveBeenCalledTimes(2));
  });

  it("after the socket reconnects, reloads so views missed while offline show up", async () => {
    const mine = { ...status("m1", "user-1", "My update", { viewedByMe: true }), visibility: "contacts" as const, audienceUserIds: [], viewCount: 1 };
    vi.mocked(statusService.list).mockResolvedValueOnce({ ...structuredClone(listResponse), mine: [mine] });
    const realtime = renderView();
    await screen.findByText(/· 1 views/);

    const later: StatusListResponse = structuredClone(listResponse);
    later.mine = [{ ...mine, viewCount: 3 }];
    vi.mocked(statusService.list).mockResolvedValueOnce(later);
    const callsBefore = vi.mocked(statusService.list).mock.calls.length;
    realtime.reconnect();

    await screen.findByText(/· 3 views/);
    expect(vi.mocked(statusService.list).mock.calls.length).toBe(callsBefore + 1);
  });
});
