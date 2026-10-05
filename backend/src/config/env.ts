import "dotenv/config";

export interface EnvConfig {
  nodeEnv: "development" | "production" | "test";
  port: number;
  /** Browser origins allowed by CORS and by the WebSocket Origin check (CLIENT_ORIGIN, comma-separated). */
  clientOrigins: string[];
  /**
   * Express `trust proxy` setting (TRUST_PROXY). Must match the deployment:
   * behind one reverse proxy use 1, so rate limits key on the real client
   * IP instead of the proxy's. false (default) = direct connections.
   */
  trustProxy: boolean | number | string;
  databaseUrl: string;
  jwt: {
    accessSecret: string;
    refreshSecret: string;
    accessExpiry: string;
    refreshExpiry: string;
  };
  bcryptSaltRounds: number;
  /**
   * Server-side abuse limits (Phase 7). All counters are in memory, per
   * backend process — see docs/security.md "Rate limiting".
   */
  rateLimit: {
    /** General per-IP limit for every request. */
    windowMs: number;
    maxRequests: number;
    /** Per-IP login + signup attempts per 15 minutes. */
    authMax: number;
    /** Per-IP token refreshes per 15 minutes. */
    refreshMax: number;
    /** Per-user limits (per minute unless noted). */
    messagesPerMinute: number;
    uploadsPerMinute: number;
    searchesPerMinute: number;
    callStartsPerMinute: number;
    statusesPerHour: number;
  };
  /** WebSocket gateway limits. */
  ws: {
    /** Inbound frames allowed per connection per 10 seconds; beyond that the connection is closed (1008). */
    maxMessagesPer10s: number;
    /** Simultaneous connections per user (tabs/devices); further upgrades get 429. */
    maxConnectionsPerUser: number;
    /** How often the server pings each connection; a connection that missed the previous ping's pong is terminated. */
    heartbeatIntervalMs: number;
  };
  /** AI provider + limits — see docs/ai.md. Keys never leave the backend. */
  ai: {
    /** "none" (default) or "anthropic". */
    provider: string;
    apiKey: string | undefined;
    model: string;
    /** Effort hint for providers that support one ("low" | "medium" | "high"); "default" = let the provider decide. */
    effort: string | undefined;
    /** Anthropic only: let the API re-run a request declined by the model's safety classifiers on a fallback model. */
    refusalFallback: boolean;
    timeoutMs: number;
    maxRetries: number;
    maxOutputTokens: number;
    /** Upper bound on the chat text put into one prompt, in characters. */
    maxContextChars: number;
    rateLimitPerMinute: number;
    rateLimitPerDay: number;
    transcription: {
      /** "none" (default) or "whisper-http" (any Whisper-compatible /audio/transcriptions endpoint). */
      provider: string;
      baseUrl: string | undefined;
      apiKey: string | undefined;
      model: string;
      maxAudioBytes: number;
    };
  };
  maxUploadSizeMb: number;
  /** Root directory for the local-disk media storage provider (development storage; see modules/media/storage). */
  uploadDir: string;
  /** Where attachment bytes live (MEDIA_STORAGE): "local" disk under uploadDir (default; development) or "cloudinary" (production). */
  mediaStorage: "local" | "cloudinary";
  cloudinary: {
    /** CLOUDINARY_URL (cloudinary://<api_key>:<api_secret>@<cloud_name>). Required when mediaStorage is "cloudinary". */
    url: string | undefined;
    /** Public-ID prefix for every stored file. Don't change it once files exist: stored keys would no longer resolve. */
    folder: string;
  };
  /** WebRTC ICE servers handed to call clients — see modules/calls/ice-servers.ts and docs/calls.md. */
  webrtc: {
    stunUrls: string[];
    turnUrls: string[];
    /** Static TURN credentials (simple setups). Ignored when turnSecret is set. */
    turnUsername: string | undefined;
    turnCredential: string | undefined;
    /** Shared secret for time-limited TURN credentials (coturn `use-auth-secret`). Preferred for production. */
    turnSecret: string | undefined;
    turnCredentialTtlSeconds: number;
  };
  calls: {
    ringTimeoutMs: number;
  };
  /** How often the Phase 6 scheduler checks for due reminders, tasks and scheduled messages. */
  schedulerIntervalMs: number;
}

function readList(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function readOptional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

/**
 * Reads a numeric variable, failing fast on typos ("15m" where a number of
 * seconds is expected) instead of silently running with NaN.
 */
function readNumber(name: string, fallback: number, bounds: { min?: number; max?: number } = {}): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Environment variable ${name} must be a number (got "${raw}")`);
  if (bounds.min !== undefined && value < bounds.min) throw new Error(`Environment variable ${name} must be >= ${bounds.min}`);
  if (bounds.max !== undefined && value > bounds.max) throw new Error(`Environment variable ${name} must be <= ${bounds.max}`);
  return value;
}

function readTrustProxy(): boolean | number | string {
  const raw = process.env.TRUST_PROXY?.trim();
  if (!raw || raw.toLowerCase() === "false") return false;
  if (raw.toLowerCase() === "true") return true;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw; // e.g. "loopback" or a comma-separated list of proxy IPs/subnets
}

function readMediaStorage(): EnvConfig["mediaStorage"] {
  const value = (process.env.MEDIA_STORAGE ?? "local").trim().toLowerCase() || "local";
  if (value !== "local" && value !== "cloudinary") {
    throw new Error(`Environment variable MEDIA_STORAGE must be "local" or "cloudinary" (got "${value}")`);
  }
  if (value === "cloudinary" && !readOptional("CLOUDINARY_URL")) {
    throw new Error("MEDIA_STORAGE=cloudinary requires CLOUDINARY_URL");
  }
  return value;
}

function readCloudinaryFolder(): string {
  const value = readOptional("CLOUDINARY_FOLDER") ?? "connectx";
  if (!/^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/.test(value)) {
    throw new Error("Environment variable CLOUDINARY_FOLDER may only contain letters, digits, _, - and / separators");
  }
  return value;
}

function readEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const isTest = process.env.NODE_ENV === "test";

export const env: EnvConfig = {
  nodeEnv: (process.env.NODE_ENV as EnvConfig["nodeEnv"]) ?? "development",
  port: readNumber("PORT", 4000, { min: 0, max: 65535 }),
  clientOrigins: readEnv("CLIENT_ORIGIN", "http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean),
  trustProxy: readTrustProxy(),
  databaseUrl: readEnv("DATABASE_URL", isTest ? "postgresql://test" : undefined),
  jwt: {
    accessSecret: readEnv("JWT_ACCESS_SECRET", isTest ? "test-access-secret" : undefined),
    refreshSecret: readEnv("JWT_REFRESH_SECRET", isTest ? "test-refresh-secret" : undefined),
    accessExpiry: process.env.JWT_ACCESS_EXPIRY ?? "15m",
    refreshExpiry: process.env.JWT_REFRESH_EXPIRY ?? "7d",
  },
  bcryptSaltRounds: readNumber("BCRYPT_SALT_ROUNDS", 12, { min: 4, max: 15 }),
  rateLimit: {
    windowMs: readNumber("RATE_LIMIT_WINDOW_MS", 60_000, { min: 1000 }),
    maxRequests: readNumber("RATE_LIMIT_MAX_REQUESTS", 300, { min: 1 }),
    authMax: readNumber("AUTH_RATE_LIMIT_MAX", 10, { min: 1 }),
    refreshMax: readNumber("REFRESH_RATE_LIMIT_MAX", 60, { min: 1 }),
    messagesPerMinute: readNumber("MESSAGE_RATE_LIMIT_PER_MINUTE", 120, { min: 1 }),
    uploadsPerMinute: readNumber("UPLOAD_RATE_LIMIT_PER_MINUTE", 30, { min: 1 }),
    searchesPerMinute: readNumber("SEARCH_RATE_LIMIT_PER_MINUTE", 60, { min: 1 }),
    callStartsPerMinute: readNumber("CALL_RATE_LIMIT_PER_MINUTE", 20, { min: 1 }),
    statusesPerHour: readNumber("STATUS_RATE_LIMIT_PER_HOUR", 30, { min: 1 }),
  },
  ws: {
    maxMessagesPer10s: readNumber("WS_MAX_MESSAGES_PER_10S", 300, { min: 10 }),
    maxConnectionsPerUser: readNumber("WS_MAX_CONNECTIONS_PER_USER", 20, { min: 1 }),
    heartbeatIntervalMs: readNumber("WS_HEARTBEAT_SECONDS", 30, { min: 5 }) * 1000,
  },
  ai: {
    provider: (process.env.AI_PROVIDER ?? "none").trim().toLowerCase() || "none",
    apiKey: readOptional("AI_PROVIDER_API_KEY"),
    model: readOptional("AI_MODEL") ?? "claude-opus-5",
    effort: readOptional("AI_EFFORT") ?? "medium",
    refusalFallback: (process.env.AI_REFUSAL_FALLBACK ?? "true").trim().toLowerCase() !== "false",
    timeoutMs: readNumber("AI_REQUEST_TIMEOUT_MS", 60_000, { min: 1000 }),
    maxRetries: readNumber("AI_MAX_RETRIES", 2, { min: 0, max: 10 }),
    maxOutputTokens: readNumber("AI_MAX_OUTPUT_TOKENS", 8000, { min: 256 }),
    maxContextChars: readNumber("AI_MAX_CONTEXT_CHARS", 24_000, { min: 1000 }),
    rateLimitPerMinute: readNumber("AI_RATE_LIMIT_PER_MINUTE", 10, { min: 1 }),
    rateLimitPerDay: readNumber("AI_RATE_LIMIT_PER_DAY", 200, { min: 1 }),
    transcription: {
      provider: (process.env.TRANSCRIPTION_PROVIDER ?? "none").trim().toLowerCase() || "none",
      baseUrl: readOptional("TRANSCRIPTION_BASE_URL"),
      apiKey: readOptional("TRANSCRIPTION_API_KEY"),
      model: readOptional("TRANSCRIPTION_MODEL") ?? "whisper-1",
      maxAudioBytes: readNumber("TRANSCRIPTION_MAX_AUDIO_MB", 25, { min: 1 }) * 1024 * 1024,
    },
  },
  maxUploadSizeMb: readNumber("MAX_UPLOAD_SIZE_MB", 25, { min: 1, max: 1024 }),
  uploadDir: process.env.UPLOAD_DIR ?? "uploads",
  mediaStorage: readMediaStorage(),
  cloudinary: {
    url: readOptional("CLOUDINARY_URL"),
    folder: readCloudinaryFolder(),
  },
  webrtc: {
    // No default ICE servers: with none configured, calls work between
    // browsers on the same machine/LAN (host candidates) and nothing is sent
    // to a third-party STUN server unless you opt in. See .env.example.
    stunUrls: readList("WEBRTC_STUN_URLS"),
    turnUrls: readList("WEBRTC_TURN_URLS"),
    turnUsername: readOptional("WEBRTC_TURN_USERNAME"),
    turnCredential: readOptional("WEBRTC_TURN_CREDENTIAL"),
    turnSecret: readOptional("WEBRTC_TURN_SECRET"),
    turnCredentialTtlSeconds: readNumber("WEBRTC_TURN_TTL_SECONDS", 3600, { min: 60 }),
  },
  calls: {
    ringTimeoutMs: readNumber("CALL_RING_TIMEOUT_SECONDS", 45, { min: 5 }) * 1000,
  },
  schedulerIntervalMs: Math.max(5, readNumber("SCHEDULER_INTERVAL_SECONDS", 15)) * 1000,
};

const PLACEHOLDER_SECRET = /replace-with|changeme|change-me|^test-/i;

/**
 * Configuration mistakes that are unsafe in production. Returns the list of
 * problems (empty = OK); server startup refuses to run with NODE_ENV=production
 * while any remain. Exported for tests.
 */
export function productionConfigProblems(config: EnvConfig): string[] {
  const problems: string[] = [];
  const { accessSecret, refreshSecret } = config.jwt;
  for (const [name, value] of [
    ["JWT_ACCESS_SECRET", accessSecret],
    ["JWT_REFRESH_SECRET", refreshSecret],
  ] as const) {
    if (value.length < 32) problems.push(`${name} must be at least 32 characters`);
    if (PLACEHOLDER_SECRET.test(value)) problems.push(`${name} still looks like a placeholder value`);
  }
  if (accessSecret === refreshSecret) problems.push("JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different");
  if (config.clientOrigins.length === 0) problems.push("CLIENT_ORIGIN must list the frontend's origin");
  if (config.clientOrigins.includes("*")) problems.push("CLIENT_ORIGIN must not be *");
  if (config.bcryptSaltRounds < 10) problems.push("BCRYPT_SALT_ROUNDS must be at least 10");
  return problems;
}
