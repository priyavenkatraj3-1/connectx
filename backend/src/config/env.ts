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
};
