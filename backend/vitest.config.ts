import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["tests/**/*.test.ts"],
    // Fail closed: every real PostgreSQL connection is refused (tests/setup/no-real-db.ts).
    setupFiles: ["./tests/setup/no-real-db.ts"],
    env: {
      // Tests only: real bcrypt at the lowest cost it allows. Hundreds of test
      // signups at the production cost (12) made CPU-heavy files run past
      // their timeouts when run in parallel. Production still refuses a cost
      // below 10 at startup (productionConfigProblems, see
      // tests/unit/production-readiness.test.ts).
      BCRYPT_SALT_ROUNDS: "4",
      // Tests always use pg-mem. These shadow backend/.env and the shell
      // (dotenv never overwrites a variable that is already set).
      // `.invalid` is reserved and never resolves (RFC 6761).
      DATABASE_URL: "postgresql://blocked.invalid:1/blocked",
      TEST_DATABASE_URL: "",
      // Keep pg on its JS client, which the setup file guards.
      NODE_PG_FORCE_NATIVE: "",
      // Tests never use a real AI or speech-to-text provider, whatever backend/.env
      // says: tests that need one inject a scripted/mocked provider into createApp,
      // and everything else gets the honest "not configured" provider. Without
      // these, a test that relies on the default would send requests (and the
      // developer's API key) to the provider configured in backend/.env.
      AI_PROVIDER: "none",
      AI_PROVIDER_API_KEY: "",
      GEMINI_API_KEY: "",
      GEMINI_MODEL: "",
      GEMINI_TRANSCRIPTION_MODEL: "",
      TRANSCRIPTION_PROVIDER: "none",
      TRANSCRIPTION_BASE_URL: "",
      TRANSCRIPTION_API_KEY: "",
    },
  },
});
