import { act, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, NetworkError } from "../services/apiClient";
import { authService } from "../services/authService";
import { AuthProvider, useAuth } from "./AuthContext";
import { RealtimeProvider, useRealtime } from "./RealtimeContext";

vi.mock("../services/authService", async (importOriginal) => {
  const original = await importOriginal<typeof import("../services/authService")>();
  return { ...original, authService: { ...original.authService, refresh: vi.fn() } };
});

const MINUTE = 60_000;
const START = new Date("2026-01-01T12:00:00Z").getTime();

/** An unsigned JWT-shaped token expiring at `expMs` — enough for the client's expiry checks. */
function jwt(label: string, expMs: number): string {
  const payload = btoa(JSON.stringify({ sub: label, exp: Math.floor(expMs / 1000) }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;
}

function seed(accessToken: string): void {
  localStorage.setItem(
    "connectx.auth",
    JSON.stringify({ user: { id: "user-1", email: "a@example.com", displayName: "Alice" }, tokens: { accessToken, refreshToken: "refresh-1" }, sessionId: "s1" })
  );
}

/** Records every socket the app opens; tests open/close them by hand. */
class RecordingWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: RecordingWebSocket[] = [];
  readyState = RecordingWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  constructor(public url: string) {
    RecordingWebSocket.instances.push(this);
  }
  get token(): string {
    return new URL(this.url).searchParams.get("token")!;
  }
  send(): void {}
  /** The server accepted the handshake. */
  open(): void {
    this.readyState = RecordingWebSocket.OPEN;
    this.onopen?.();
  }
  /** The connection dropped (server restart, network blip, or a refused handshake). */
  drop(): void {
    this.readyState = RecordingWebSocket.CLOSED;
    this.onclose?.({ code: 1006 });
  }
  close(): void {
    this.readyState = RecordingWebSocket.CLOSED;
    this.onclose?.({ code: 1000 });
  }
}

const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

describe("access token expiry while the app is open", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: START });
    localStorage.clear();
    RecordingWebSocket.instances = [];
    vi.stubGlobal("WebSocket", RecordingWebSocket);
    vi.mocked(authService.refresh).mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("refreshes an expired token before reconnecting the socket, then signals the reconnect", async () => {
    seed(jwt("old", START + 15 * MINUTE));
    const fresh = jwt("fresh", START + 60 * MINUTE);
    vi.mocked(authService.refresh).mockResolvedValue({ tokens: { accessToken: fresh, refreshToken: "refresh-2" }, session: { id: "s1" } });
    const onReconnect = vi.fn();
    function ReconnectProbe() {
      const { onReconnect: subscribeReconnect } = useRealtime();
      useEffect(() => subscribeReconnect?.(onReconnect), [subscribeReconnect]);
      return null;
    }
    render(
      <AuthProvider>
        <RealtimeProvider>
          <ReconnectProbe />
        </RealtimeProvider>
      </AuthProvider>
    );
    const first = RecordingWebSocket.instances[0]!;
    act(() => first.open());

    // The computer sleeps for 20 minutes: the scheduled refresh never ran and the token is now expired.
    vi.setSystemTime(START + 20 * MINUTE);
    act(() => first.drop());
    await advance(2_000);

    expect(authService.refresh).toHaveBeenCalledTimes(1);
    // Exactly one new connection, with the fresh token — never a retry with the dead one (which the server refuses forever).
    const sockets = RecordingWebSocket.instances.slice(1);
    expect(sockets.map((s) => s.token)).toEqual([fresh]);
    await advance(10_000);
    expect(RecordingWebSocket.instances).toHaveLength(2);

    expect(onReconnect).not.toHaveBeenCalled();
    act(() => sockets[0]!.open());
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it("opens the socket with a refreshed token when the stored one has already expired", async () => {
    seed(jwt("old", START - MINUTE));
    const fresh = jwt("fresh", START + 15 * MINUTE);
    vi.mocked(authService.refresh).mockResolvedValue({ tokens: { accessToken: fresh, refreshToken: "refresh-2" }, session: { id: "s1" } });
    render(
      <AuthProvider>
        <RealtimeProvider>{null}</RealtimeProvider>
      </AuthProvider>
    );
    await advance(0);

    expect(authService.refresh).toHaveBeenCalledTimes(1);
    expect(RecordingWebSocket.instances.map((s) => s.token)).toEqual([fresh]);
  });

  it("retries a refresh that failed on the network instead of leaving the token expired", async () => {
    seed(jwt("old", START + 30_000)); // inside the refresh lead time → refresh right away
    vi.mocked(authService.refresh)
      .mockRejectedValueOnce(new NetworkError())
      .mockResolvedValue({ tokens: { accessToken: jwt("fresh", START + 15 * MINUTE), refreshToken: "refresh-2" }, session: { id: "s1" } });
    render(<AuthProvider>{null}</AuthProvider>);

    await advance(0);
    expect(authService.refresh).toHaveBeenCalledTimes(1);
    await advance(15_000);
    expect(authService.refresh).toHaveBeenCalledTimes(2);
    expect(JSON.parse(localStorage.getItem("connectx.auth")!).tokens.refreshToken).toBe("refresh-2");
  });

  it("refreshes when the window regains focus after the token expired unnoticed", async () => {
    seed(jwt("old", START + 15 * MINUTE));
    vi.mocked(authService.refresh).mockResolvedValue({
      tokens: { accessToken: jwt("fresh", START + 60 * MINUTE), refreshToken: "refresh-2" },
      session: { id: "s1" },
    });
    render(<AuthProvider>{null}</AuthProvider>);
    await advance(0);
    expect(authService.refresh).not.toHaveBeenCalled();

    vi.setSystemTime(START + 20 * MINUTE); // slept; the timer didn't fire
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(authService.refresh).toHaveBeenCalledTimes(1);
  });
});

/**
 * Mimics the backend's refresh rotation: each refresh token works once, and
 * presenting an already-rotated one is treated as theft and revokes the session.
 */
function rotatingRefreshServer() {
  const server = { valid: "refresh-1", issued: 1, revoked: false };
  vi.mocked(authService.refresh).mockImplementation(async (refreshToken: string) => {
    await Promise.resolve();
    if (server.revoked || refreshToken !== server.valid) {
      server.revoked = true;
      throw new ApiError("This session has ended. Please sign in again.", 401, "session_revoked");
    }
    server.issued += 1;
    server.valid = `refresh-${server.issued}`;
    return { tokens: { accessToken: jwt(`fresh-${server.issued}`, START + 60 * MINUTE), refreshToken: server.valid }, session: { id: "s1" } };
  });
  return server;
}

/** Web Locks stand-in: callbacks for the same lock run one after another. */
function installFakeLocks(): void {
  let tail: Promise<unknown> = Promise.resolve();
  const request = (_name: string, callback: () => Promise<unknown>) => {
    const run = tail.then(callback);
    tail = run.catch(() => undefined);
    return run;
  };
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request } });
}

type Tabs = Record<string, ReturnType<typeof useAuth>>;

/** Two AuthProviders sharing localStorage but not memory — like two browser tabs. */
function renderTwoTabs(): Tabs {
  const tabs: Tabs = {};
  function Tab({ name }: { name: string }) {
    tabs[name] = useAuth();
    return null;
  }
  render(
    <>
      <AuthProvider>
        <Tab name="a" />
      </AuthProvider>
      <AuthProvider>
        <Tab name="b" />
      </AuthProvider>
    </>
  );
  return tabs;
}

const storedRefreshToken = () => JSON.parse(localStorage.getItem("connectx.auth")!).tokens.refreshToken as string;

describe("two tabs sharing one session", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: START });
    localStorage.clear();
    vi.mocked(authService.refresh).mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    delete (navigator as { locks?: unknown }).locks;
  });

  it("refreshing concurrently submits the refresh token once, and both tabs get the new tokens", async () => {
    installFakeLocks();
    const server = rotatingRefreshServer();
    seed(jwt("old", START + 30_000)); // inside the refresh lead time: both tabs' timers fire at once
    const tabs = renderTwoTabs();

    await advance(0);
    await advance(0);

    expect(authService.refresh).toHaveBeenCalledTimes(1);
    expect(authService.refresh).toHaveBeenCalledWith("refresh-1");
    expect(server.revoked).toBe(false);
    expect(tabs.a!.isAuthenticated && tabs.b!.isAuthenticated).toBe(true);
    expect(tabs.a!.accessToken).toBe(jwt("fresh-2", START + 60 * MINUTE));
    expect(tabs.b!.accessToken).toBe(tabs.a!.accessToken);
    expect(storedRefreshToken()).toBe("refresh-2");
  });

  it("without Web Locks, a tab refreshing after another uses the tokens it stored instead of the rotated-out one", async () => {
    const server = rotatingRefreshServer();
    seed(jwt("old", START + 15 * MINUTE));
    const tabs = renderTwoTabs();

    await act(async () => {
      await tabs.a!.refreshAccessToken();
    });
    let fromB: string | null = null;
    await act(async () => {
      fromB = await tabs.b!.refreshAccessToken();
    });

    expect(authService.refresh).toHaveBeenCalledTimes(1);
    expect(server.revoked).toBe(false);
    expect(fromB).toBe(tabs.a!.accessToken);
    expect(tabs.b!.accessToken).toBe(tabs.a!.accessToken);
    expect(tabs.b!.isAuthenticated).toBe(true);
  });

  it("adopts tokens another tab stored for the same session, and ignores other accounts", async () => {
    seed(jwt("old", START + 15 * MINUTE));
    const tabs = renderTwoTabs();
    const original = tabs.b!.accessToken;

    const otherAccount = JSON.stringify({
      user: { id: "user-9", email: "z@example.com", displayName: "Zed" },
      tokens: { accessToken: jwt("zed", START + 15 * MINUTE), refreshToken: "zed-refresh" },
      sessionId: "s9",
    });
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: "connectx.auth", newValue: otherAccount })));
    expect(tabs.b!.accessToken).toBe(original);

    const rotated = JSON.parse(localStorage.getItem("connectx.auth")!);
    rotated.tokens = { accessToken: jwt("rotated", START + 30 * MINUTE), refreshToken: "refresh-2" };
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: "connectx.auth", newValue: JSON.stringify(rotated) })));
    expect(tabs.b!.accessToken).toBe(rotated.tokens.accessToken);
    expect(authService.refresh).not.toHaveBeenCalled();
  });
});
