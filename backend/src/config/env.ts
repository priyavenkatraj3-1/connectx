import "dotenv/config";

interface EnvConfig {
  nodeEnv: "development" | "production" | "test";
  port: number;
  clientOrigin: string;
  databaseUrl: string;
  jwt: {
    accessSecret: string;
    refreshSecret: string;
    accessExpiry: string;
    refreshExpiry: string;
  };
  bcryptSaltRounds: number;
  rateLimit: {
    windowMs: number;
    maxRequests: number;
  };
  ai: {
    provider: string;
    apiKey: string | undefined;
  };
  maxUploadSizeMb: number;
  /** Root directory for the local-disk media storage provider (development storage; see modules/media/storage). */
  uploadDir: string;
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
  port: Number(process.env.PORT ?? 4000),
  clientOrigin: readEnv("CLIENT_ORIGIN", "http://localhost:5173"),
  databaseUrl: readEnv("DATABASE_URL", isTest ? "postgresql://test" : undefined),
  jwt: {
    accessSecret: readEnv("JWT_ACCESS_SECRET", isTest ? "test-access-secret" : undefined),
    refreshSecret: readEnv("JWT_REFRESH_SECRET", isTest ? "test-refresh-secret" : undefined),
    accessExpiry: process.env.JWT_ACCESS_EXPIRY ?? "15m",
    refreshExpiry: process.env.JWT_REFRESH_EXPIRY ?? "7d",
  },
  bcryptSaltRounds: Number(process.env.BCRYPT_SALT_ROUNDS ?? 12),
  rateLimit: {
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000),
    maxRequests: Number(process.env.RATE_LIMIT_MAX_REQUESTS ?? 100),
  },
  ai: {
    provider: process.env.AI_PROVIDER ?? "none",
    apiKey: process.env.AI_PROVIDER_API_KEY,
  },
  maxUploadSizeMb: Number(process.env.MAX_UPLOAD_SIZE_MB ?? 25),
  uploadDir: process.env.UPLOAD_DIR ?? "uploads",
  webrtc: {
    // No default ICE servers: with none configured, calls work between
    // browsers on the same machine/LAN (host candidates) and nothing is sent
    // to a third-party STUN server unless you opt in. See .env.example.
    stunUrls: readList("WEBRTC_STUN_URLS"),
    turnUrls: readList("WEBRTC_TURN_URLS"),
    turnUsername: readOptional("WEBRTC_TURN_USERNAME"),
    turnCredential: readOptional("WEBRTC_TURN_CREDENTIAL"),
    turnSecret: readOptional("WEBRTC_TURN_SECRET"),
    turnCredentialTtlSeconds: Number(process.env.WEBRTC_TURN_TTL_SECONDS ?? 3600),
  },
  calls: {
    ringTimeoutMs: Number(process.env.CALL_RING_TIMEOUT_SECONDS ?? 45) * 1000,
  },
};
