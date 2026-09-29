export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4000/api/v1";

/** Derives the WebSocket gateway URL from the REST API base (http(s) -> ws(s), drops the /api/v1 suffix), unless VITE_WS_URL overrides it explicitly. */
export const WS_BASE_URL = import.meta.env.VITE_WS_URL ?? API_BASE_URL.replace(/^http/, "ws").replace(/\/api\/v1\/?$/, "") + "/ws";

export function buildQueryString(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    /** Machine-readable error code from the server, when it sends one (e.g. "ai_not_configured"). */
    public readonly code?: string
  ) {
    super(message);
  }
}

/**
 * The request never got an HTTP response (offline, DNS failure, server
 * down, connection dropped). The server may or may not have processed it —
 * callers that retry must use an idempotency key (see messageService.send).
 */
export class NetworkError extends Error {
  constructor(
    message = "You appear to be offline.",
    /** Set by messageService.send so a retry can reuse the same idempotency key. */
    public readonly clientMessageId?: string
  ) {
    super(message);
  }
}

export function isNetworkError(err: unknown): err is NetworkError {
  return err instanceof NetworkError;
}

/**
 * Called when the server says this device's session has ended
 * ("session_revoked" / "session_expired") — AuthContext signs out locally.
 */
let sessionEndedHandler: ((code: string) => void) | null = null;
export function setSessionEndedHandler(handler: ((code: string) => void) | null): void {
  sessionEndedHandler = handler;
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  accessToken?: string;
}

export async function apiRequest<TResponse>(path: string, options: RequestOptions = {}): Promise<TResponse> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (options.accessToken) {
    headers.Authorization = `Bearer ${options.accessToken}`;
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  } catch (err) {
    // fetch only rejects when no HTTP response arrived at all.
    throw new NetworkError(err instanceof Error && err.message ? `Network error: ${err.message}` : undefined);
  }

  if (response.status === 204) {
    return undefined as TResponse;
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = data?.error?.message ?? "Something went wrong. Please try again.";
    const code = typeof data?.error?.code === "string" ? (data.error.code as string) : undefined;
    if (response.status === 401 && (code === "session_revoked" || code === "session_expired") && options.accessToken) {
      sessionEndedHandler?.(code);
    }
    throw new ApiError(message, response.status, code);
  }

  return data as TResponse;
}

/** RFC 4122 v4 UUID (crypto.randomUUID where available). */
export function generateUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}
