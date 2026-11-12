import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

/** Hosts that only make sense for a local production-mode build (warned about, not refused). */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]);

/**
 * The API location is baked into the bundle at build time, and the app's
 * fallback (http://localhost:4000/api/v1, see src/services/apiClient.ts) is
 * for `vite` dev mode only. A production build must say where the API is,
 * so it fails here instead of shipping a bundle that silently talks to
 * localhost. Never prints the values beyond the URL being checked.
 */
function checkBuildEnv(env: Record<string, string>): void {
  const problems: string[] = [];
  const warnings: string[] = [];

  const apiBase = env.VITE_API_BASE_URL?.trim();
  if (!apiBase) {
    problems.push("VITE_API_BASE_URL is not set. Set it to the backend API, e.g. https://api.chat.example.com/api/v1");
  } else {
    const url = parseUrl(apiBase);
    if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) {
      problems.push("VITE_API_BASE_URL must be an absolute http(s) URL, e.g. https://api.chat.example.com/api/v1");
    } else if (LOCAL_HOSTS.has(url.hostname)) {
      warnings.push(`VITE_API_BASE_URL points at ${url.host}: this build only works on the machine running the backend.`);
    }
  }

  const wsUrl = env.VITE_WS_URL?.trim();
  if (wsUrl) {
    const url = parseUrl(wsUrl);
    if (!url || (url.protocol !== "wss:" && url.protocol !== "ws:")) {
      problems.push("VITE_WS_URL, when set, must be an absolute ws(s) URL, e.g. wss://api.chat.example.com/ws");
    } else if (LOCAL_HOSTS.has(url.hostname)) {
      warnings.push(`VITE_WS_URL points at ${url.host}: this build only works on the machine running the backend.`);
    }
  }

  for (const warning of warnings) console.warn(`\n[connectx] Warning: ${warning}\n`);
  if (problems.length > 0) {
    throw new Error(`Refusing to build the frontend:\n  - ${problems.join("\n  - ")}\nSee docs/deployment.md §3.`);
  }
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export default defineConfig(({ command, mode }) => {
  // Same sources Vite uses for import.meta.env: frontend/.env*, then the shell.
  if (command === "build") checkBuildEnv(loadEnv(mode, process.cwd(), "VITE_"));
  return {
    plugins: [react()],
    server: {
      port: 5173,
    },
  };
});
