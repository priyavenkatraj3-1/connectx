import { createServer } from "http";
import { createApp } from "./app";
import { env } from "./config/env";
import { buildGatewayOptions } from "./realtime/gateway-handlers";
import { attachWebSocketGateway, WS_PATH } from "./realtime/ws.server";

const STATUS_SWEEP_INTERVAL_MS = 60_000;

async function main(): Promise<void> {
  const { app, container } = createApp();

  try {
    await container.db.query("SELECT 1");
  } catch (err) {
    console.error("\nFailed to connect to the database.\n");
    console.error(`DATABASE_URL is currently: ${env.databaseUrl}`);
    console.error(
      [
        "",
        "ConnectX needs a running, migrated PostgreSQL database. To fix this:",
        "  1. Install PostgreSQL locally (or run it via Docker) and create a database.",
        "  2. Set DATABASE_URL in backend/.env to point at it.",
        "  3. Run: npm run db:migrate --workspace=backend",
        "",
        "See the root README.md for exact setup steps.",
        "",
      ].join("\n")
    );
    const code = err && typeof err === "object" && "code" in err ? ` (${String((err as { code: unknown }).code)})` : "";
    const message = err instanceof Error && err.message ? err.message : String(err);
    console.error(`Underlying error: ${message}${code}`);
    process.exit(1);
  }

  // Calls still marked live from a previous run can't be signaled any more (that state lived in memory).
  const staleCalls = await container.callsService.recoverStaleCalls();
  if (staleCalls > 0) console.log(`Marked ${staleCalls} call(s) interrupted by the last shutdown as failed.`);

  const httpServer = createServer(app);

  const realtimeGateway = attachWebSocketGateway(httpServer, buildGatewayOptions(container));
  container.realtimeGatewayRef.current = realtimeGateway;

  // Expired statuses are already hidden by every query; this sweep notifies
  // open clients and deletes the expired rows and their media.
  const sweepStatuses = () =>
    void container.statusesService.sweepExpired().catch((err) => console.error("[status sweep failed]", err));
  sweepStatuses();
  setInterval(sweepStatuses, STATUS_SWEEP_INTERVAL_MS).unref();

  httpServer.listen(env.port, () => {
    console.log(`ConnectX backend listening on port ${env.port} [${env.nodeEnv}]`);
    console.log(`WebSocket gateway available at ws://localhost:${env.port}${WS_PATH}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
