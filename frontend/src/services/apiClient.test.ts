import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiRequest, setAccessTokenRefresher } from "./apiClient";
import { mediaService } from "./mediaService";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const expired = () => jsonResponse(401, { error: { message: "Invalid or expired token" } });

function authHeader(call: unknown[]): string | undefined {
  return ((call[1] as RequestInit).headers as Record<string, string>).Authorization;
}

describe("apiRequest — expired access token", () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    setAccessTokenRefresher(null);
    vi.unstubAllGlobals();
  });

  it("refreshes the token and retries the request once", async () => {
    const refresher = vi.fn().mockResolvedValue("fresh-token");
    setAccessTokenRefresher(refresher);
    fetchMock.mockResolvedValueOnce(expired()).mockResolvedValueOnce(jsonResponse(201, { call: { id: "c1" } }));

    await expect(apiRequest("/calls", { method: "POST", body: { media: "audio" }, accessToken: "stale-token" })).resolves.toEqual({
      call: { id: "c1" },
    });

    expect(refresher).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(authHeader(fetchMock.mock.calls[0]!)).toBe("Bearer stale-token");
    expect(authHeader(fetchMock.mock.calls[1]!)).toBe("Bearer fresh-token");
    expect((fetchMock.mock.calls[1]![1] as RequestInit).body).toBe(JSON.stringify({ media: "audio" }));
  });

  it("gives up after one retry", async () => {
    setAccessTokenRefresher(vi.fn().mockResolvedValue("fresh-token"));
    fetchMock.mockResolvedValueOnce(expired()).mockResolvedValueOnce(expired());

    await expect(apiRequest("/calls", { accessToken: "stale-token" })).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces the original error when the refresh fails or returns the same token", async () => {
    setAccessTokenRefresher(vi.fn().mockResolvedValue(null));
    fetchMock.mockResolvedValueOnce(expired());
    await expect(apiRequest("/calls", { accessToken: "stale-token" })).rejects.toThrow("Invalid or expired token");

    setAccessTokenRefresher(vi.fn().mockResolvedValue("stale-token"));
    fetchMock.mockResolvedValueOnce(expired());
    await expect(apiRequest("/calls", { accessToken: "stale-token" })).rejects.toThrow("Invalid or expired token");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("doesn't refresh for a revoked session, a non-401 error or an unauthenticated request", async () => {
    const refresher = vi.fn().mockResolvedValue("fresh-token");
    setAccessTokenRefresher(refresher);

    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: { message: "Signed out", code: "session_revoked" } }));
    await expect(apiRequest("/calls", { accessToken: "t" })).rejects.toBeInstanceOf(ApiError);

    fetchMock.mockResolvedValueOnce(jsonResponse(403, { error: { message: "Forbidden" } }));
    await expect(apiRequest("/calls", { accessToken: "t" })).rejects.toMatchObject({ status: 403 });

    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: { message: "Invalid email or password" } }));
    await expect(apiRequest("/auth/login", { method: "POST", body: {} })).rejects.toMatchObject({ status: 401 });

    expect(refresher).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

/** Minimal XMLHttpRequest stand-in that answers each send() with the next queued response. */
class FakeXhr {
  static responses: Array<{ status: number; body: unknown }> = [];
  static sent: Array<{ headers: Record<string, string>; body: unknown }> = [];
  status = 0;
  responseText = "";
  upload = { onprogress: null as unknown };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  private headers: Record<string, string> = {};
  open(): void {}
  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }
  private done = false;
  send(body: unknown): void {
    FakeXhr.sent.push({ headers: this.headers, body });
    const next = FakeXhr.responses.shift();
    if (!next) return; // no queued response: the request stays in flight until aborted
    queueMicrotask(() => {
      if (this.done) return;
      this.done = true;
      this.status = next.status;
      this.responseText = JSON.stringify(next.body);
      this.onload?.();
    });
  }
  abort(): void {
    if (this.done) return; // like a real XHR, aborting a finished request does nothing
    this.done = true;
    this.onabort?.();
  }
}

describe("mediaService.upload — expired access token", () => {
  beforeEach(() => {
    FakeXhr.responses = [];
    FakeXhr.sent = [];
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
  });
  afterEach(() => {
    setAccessTokenRefresher(null);
    vi.unstubAllGlobals();
  });

  it("refreshes the token and resends the file once", async () => {
    setAccessTokenRefresher(vi.fn().mockResolvedValue("fresh-token"));
    FakeXhr.responses.push({ status: 401, body: { error: { message: "Invalid or expired token" } } });
    FakeXhr.responses.push({ status: 201, body: { attachment: { id: "a1" } } });
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });

    await expect(mediaService.upload("stale-token", "conv-1", file).promise).resolves.toEqual({ id: "a1" });

    expect(FakeXhr.sent.map((s) => s.headers.Authorization)).toEqual(["Bearer stale-token", "Bearer fresh-token"]);
    expect(FakeXhr.sent[1]!.body).toBe(file);
  });

  it("reports a cancellation (not the 401) when cancelled while the token is being refreshed", async () => {
    let finishRefresh!: (token: string) => void;
    setAccessTokenRefresher(() => new Promise<string>((resolve) => (finishRefresh = resolve)));
    FakeXhr.responses.push({ status: 401, body: { error: { message: "Invalid or expired token" } } });
    const handle = mediaService.upload("stale-token", "conv-1", new File(["hello"], "notes.txt"));
    const outcome = handle.promise.catch((err: unknown) => err);

    await vi.waitFor(() => expect(finishRefresh).toBeTypeOf("function"));
    handle.abort();
    finishRefresh("fresh-token");

    const err = await outcome;
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ message: "Upload cancelled", status: 0 });
    expect(FakeXhr.sent).toHaveLength(1); // the file is not resent after the user cancelled
  });

  it("reports a cancellation when cancelled during the resend with the refreshed token", async () => {
    setAccessTokenRefresher(vi.fn().mockResolvedValue("fresh-token"));
    FakeXhr.responses.push({ status: 401, body: { error: { message: "Invalid or expired token" } } });
    const handle = mediaService.upload("stale-token", "conv-1", new File(["hello"], "notes.txt"));
    const outcome = handle.promise.catch((err: unknown) => err);

    await vi.waitFor(() => expect(FakeXhr.sent).toHaveLength(2)); // resend in flight (no queued response)
    handle.abort();

    expect(await outcome).toMatchObject({ message: "Upload cancelled", status: 0 });
  });

  it("still reports the server's size error without retrying", async () => {
    const refresher = vi.fn().mockResolvedValue("fresh-token");
    setAccessTokenRefresher(refresher);
    FakeXhr.responses.push({ status: 413, body: { error: { message: "File exceeds the maximum size of 10MB" } } });

    await expect(mediaService.upload("t", "conv-1", new File(["x"], "big.pdf")).promise).rejects.toMatchObject({
      status: 413,
      message: "File exceeds the maximum size of 10MB",
    });
    expect(refresher).not.toHaveBeenCalled();
  });
});
