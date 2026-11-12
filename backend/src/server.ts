import { createServer } from "http";
import { createApp } from "./app";
import { env, productionConfigProblems } from "./config/env";
import { buildGatewayOptions } from "./realtime/gateway-handlers";
import { attachWebSocketGateway, WS_PATH } from "./realtime/ws.server";
import { logger, redactUrl } from "./utils/logger";

const STATUS_SWEEP_INTERVAL_MS = 60_000;
/** How long in-flight HTTP requests get to finish on shutdown before the process exits anyway. */
const SHUTDOWN_GRACE_MS = 10_000;

async function main(): Promise<void> {
  if (env.nodeEnv === "production") {
    const problems = productionConfigProblems(env);
    if (problems.length > 0) {
      logger.error(`Refusing to start: unsafe production configuration:\n  - ${problems.join("\n  - ")}`);
      process.exit(1);
    }
  }

  const { app, container } = createApp();

  try {
    await container.db.query("SELECT 1");
  } catch (err) {
    logger.error(
      [
        "",
        "Failed to connect to the database.",
        "",
        // Credentials are masked: this line ends up in log files.
        `DATABASE_URL is currently: ${redactUrl(env.databaseUrl)}`,
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
    logger.error(`Underlying error: ${redactUrl(message)}${code}`);
    process.exit(1);
  }

  if (env.backgroundJobsEnabled) {
    // Calls still marked live from a previous run can't be signaled any more (that state lived in memory).
    const staleCalls = await container.callsService.recoverStaleCalls();
    if (staleCalls > 0) logger.info(`Marked ${staleCalls} call(s) interrupted by the last shutdown as failed.`);
  } else {
    logger.warn(
      "BACKGROUND_JOBS_ENABLED=false: skipping startup recovery, the status sweep and the scheduler. Intended only for isolated local manual testing."
    );
  }

  const httpServer = createServer(app);

  const realtimeGateway = attachWebSocketGateway(httpServer, buildGatewayOptions(container));
  container.realtimeGatewayRef.current = realtimeGateway;

  // Left unset when background jobs are off; clearInterval(undefined) on shutdown is a no-op.
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  let schedulerTimer: ReturnType<typeof setInterval> | undefined;
  if (env.backgroundJobsEnabled) {
    // Expired statuses are already hidden by every query; this sweep notifies
    // open clients and deletes the expired rows and their media.
    const sweepStatuses = () =>
      void container.statusesService.sweepExpired().catch((err) => logger.error("[status sweep failed]", err));
    sweepStatuses();
    sweepTimer = setInterval(sweepStatuses, STATUS_SWEEP_INTERVAL_MS);
    sweepTimer.unref();

    // Phase 6 scheduler: reminders, task-due notifications, scheduled messages.
    // Scheduled messages left mid-send by a crash are safe to retry (sends are idempotent).
    const stuck = await container.scheduledMessagesService.recoverStuck();
    if (stuck > 0) logger.info(`Re-queued ${stuck} scheduled message(s) interrupted by the last shutdown.`);
    const runScheduler = () =>
      void container.schedulerService.tick().catch((err) => logger.error("[scheduler tick failed]", err));
    runScheduler();
    schedulerTimer = setInterval(runScheduler, env.schedulerIntervalMs);
    schedulerTimer.unref();
  }

  httpServer.listen(env.port, () => {
    logger.info(`ConnectX backend listening on port ${env.port} [${env.nodeEnv}]`);
    logger.info(`WebSocket gateway available at ws://localhost:${env.port}${WS_PATH}`);
  });

  // --- Graceful shutdown ---------------------------------------------------
  // SIGTERM (container stop / process manager) or SIGINT (Ctrl+C): stop the
  // timers, close sockets with 1001 so clients reconnect elsewhere, let
  // in-flight HTTP requests finish, then close the database pool. Live
  // calls are marked failed on the next start (recoverStaleCalls).
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received — shutting down.`);
    clearInterval(sweepTimer);
    clearInterval(schedulerTimer);

    const force = setTimeout(() => {
      logger.warn("Shutdown grace period elapsed; exiting with requests still open.");
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    force.unref();

    void (async () => {
      await realtimeGateway.close().catch((err) => logger.error("[shutdown] closing WebSocket gateway failed", err));
      const httpClosed = new Promise<void>((resolve) => httpServer.close(() => resolve()));
      httpServer.closeIdleConnections(); // keep-alive sockets with no request in flight
      await httpClosed;
      await container.db.close().catch((err) => logger.error("[shutdown] closing database pool failed", err));
      logger.info("Shutdown complete.");
      process.exit(0);
    })();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// A stray rejected promise is logged, not fatal: every request path already
// has its own error handling, so this is a bug to fix, not a reason to drop
// every other user's connection.
process.on("unhandledRejection", (reason) => {
  logger.error("[unhandled promise rejection]", reason);
});

// After an uncaught exception the process state is unknown; log it and exit
// so the process manager restarts a clean instance.
process.on("uncaughtException", (err) => {
  logger.error("[uncaught exception] exiting", err);
  process.exit(1);
});

main().catch((err) => {
  logger.error("[startup failed]", err);
  process.exitCode = 1;
});
