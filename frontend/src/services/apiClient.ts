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
    public readonly status: number
  ) {
    super(message);
  }
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

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (response.status === 204) {
    return undefined as TResponse;
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = data?.error?.message ?? "Something went wrong. Please try again.";
    throw new ApiError(message, response.status);
  }

  return data as TResponse;
}
