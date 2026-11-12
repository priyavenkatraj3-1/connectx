import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "../../context/AuthContext";
import { ConversationsProvider } from "../../context/ConversationsContext";
import { RealtimeContext } from "../../context/RealtimeContext";
import { useOwnProfileSync } from "../../hooks/useOwnProfileSync";
import { API_BASE_URL, ApiError, setAccessTokenRefresher } from "../../services/apiClient";
import { conversationService } from "../../services/conversationService";
import { userService } from "../../services/userService";
import { createFakeRealtime } from "../../tests/fakeWebRtc";
import { seedAuthenticatedSession } from "../../tests/testAuth";
import { ChatListPanel } from "../chat/ChatListPanel";
import { Avatar, resolveAvatarUrl } from "../ui/Avatar";

vi.mock("../../services/conversationService", () => ({ conversationService: { list: vi.fn(), createDirect: vi.fn() } }));

const UPLOADED = "/api/v1/users/user-2/avatar/11111111-1111-4111-8111-111111111111";

describe("Avatar", () => {
  it("resolves uploaded pictures against the API origin and leaves external URLs alone", () => {
    expect(resolveAvatarUrl(UPLOADED)).toBe(new URL(UPLOADED, new URL(API_BASE_URL, window.location.href)).toString());
    expect(resolveAvatarUrl("https://images.example.com/a.png")).toBe("https://images.example.com/a.png");
  });

  it("falls back to initials when the picture can't load", () => {
    render(<Avatar name="Grace Hopper" imageUrl="https://images.example.com/broken.png" />);
    fireEvent.error(screen.getByRole("img", { name: "Grace Hopper" }));
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText("GH")).toBeInTheDocument();
  });
});

describe("userService.uploadAvatar", () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    setAccessTokenRefresher(null);
    vi.unstubAllGlobals();
  });
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const image = new Blob(["jpeg"], { type: "image/jpeg" });

  it("PUTs the raw image as the signed-in user", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { id: "user-1", avatarUrl: UPLOADED }));
    await expect(userService.uploadAvatar("token-1", image)).resolves.toMatchObject({ avatarUrl: UPLOADED });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${API_BASE_URL}/users/me/avatar`);
    expect(init).toMatchObject({ method: "PUT", body: image });
    expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer token-1");
    expect((init!.headers as Record<string, string>)["Content-Type"]).toBe("image/jpeg");
  });

  it("retries once with a refreshed token, and reports server errors as they are", async () => {
    setAccessTokenRefresher(vi.fn().mockResolvedValue("token-2"));
    fetchMock.mockResolvedValueOnce(json(401, { error: { message: "Invalid or expired token" } })).mockResolvedValueOnce(json(200, { avatarUrl: UPLOADED }));
    await expect(userService.uploadAvatar("token-1", image)).resolves.toMatchObject({ avatarUrl: UPLOADED });
    expect((fetchMock.mock.calls[1]![1]!.headers as Record<string, string>).Authorization).toBe("Bearer token-2");

    fetchMock.mockResolvedValueOnce(json(413, { error: { message: "Profile pictures can be at most 2MB" } }));
    await expect(userService.uploadAvatar("token-2", image)).rejects.toMatchObject({ status: 413, message: "Profile pictures can be at most 2MB" });
  });

  it("an aborted upload is reported as cancelled, without retrying", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(() => {
      controller.abort();
      return Promise.reject(new DOMException("aborted", "AbortError"));
    });
    await expect(userService.uploadAvatar("token-1", image, controller.signal)).rejects.toEqual(new ApiError("Upload cancelled", 0));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("keeping pictures consistent", () => {
  beforeEach(() => {
    localStorage.clear();
    seedAuthenticatedSession();
  });

  it("loads your own picture once per sign-in and follows changes made on another device", async () => {
    const getMe = vi.spyOn(userService, "getMe").mockResolvedValue({
      id: "user-1",
      email: "test@example.com",
      displayName: "Test User",
      avatarUrl: "/api/v1/users/user-1/avatar/22222222-2222-4222-8222-222222222222",
      bio: null,
      statusMessage: null,
      createdAt: new Date().toISOString(),
    });
    const realtime = createFakeRealtime();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <AuthProvider>
        <RealtimeContext.Provider value={realtime.value}>{children}</RealtimeContext.Provider>
      </AuthProvider>
    );
    const { result, rerender } = renderHook(
      () => {
        useOwnProfileSync();
        return useAuth().user;
      },
      { wrapper }
    );
    await waitFor(() => expect(result.current?.avatarUrl).toBe("/api/v1/users/user-1/avatar/22222222-2222-4222-8222-222222222222"));
    rerender();
    expect(getMe).toHaveBeenCalledTimes(1);

    realtime.emit({ type: "user:updated", user: { id: "user-2", displayName: "Someone else", avatarUrl: null, statusMessage: null } });
    expect(result.current?.displayName).toBe("Test User");
    realtime.emit({ type: "user:updated", user: { id: "user-1", displayName: "Renamed", avatarUrl: null, statusMessage: null } });
    expect(result.current).toMatchObject({ displayName: "Renamed", avatarUrl: null });
    getMe.mockRestore();
  });

  it("someone you chat with changing their picture updates your chat list live", async () => {
    vi.mocked(conversationService.list).mockResolvedValue([
      {
        id: "conv-1",
        type: "direct",
        otherParticipant: { id: "user-2", displayName: "Grace Hopper", avatarUrl: null, statusMessage: null },
        lastMessage: null,
        unreadCount: 0,
        updatedAt: new Date().toISOString(),
      },
    ]);
    const realtime = createFakeRealtime();
    render(
      <AuthProvider>
        <RealtimeContext.Provider value={realtime.value}>
          <ConversationsProvider>
            <MemoryRouter>
              <ChatListPanel />
            </MemoryRouter>
          </ConversationsProvider>
        </RealtimeContext.Provider>
      </AuthProvider>
    );
    await screen.findByText("Grace Hopper");
    expect(screen.queryByRole("img", { name: "Grace Hopper" })).not.toBeInTheDocument();

    act(() => realtime.emit({ type: "user:updated", user: { id: "user-2", displayName: "Grace Hopper", avatarUrl: UPLOADED, statusMessage: null } }));
    expect(screen.getByRole("img", { name: "Grace Hopper" })).toHaveAttribute("src", resolveAvatarUrl(UPLOADED));
  });
});
