import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import { type Container, type ContainerOverrides, createContainer } from "./container";
import { env } from "./config/env";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import { apiRateLimiter, createUserRateLimiters } from "./middleware/rateLimiter";
import { createSessionGuard } from "./middleware/requireAuth";
import { createAIRouter } from "./modules/ai/ai.routes";
import { createAuthRouter } from "./modules/auth/auth.routes";
import { createBusinessRouter } from "./modules/business/business.routes";
import { createCallsRouter } from "./modules/calls/calls.routes";
import { createNotesRouter, createTodoRouters } from "./modules/collaboration/collaboration.routes";
import { createConversationsRouter } from "./modules/conversations/conversations.routes";
import { createGroupsRouter } from "./modules/groups/groups.routes";
import { createMediaRouter } from "./modules/media/media.routes";
import { createMessagesRouter } from "./modules/messages/messages.routes";
import { createNotificationsRouter } from "./modules/notifications/notifications.routes";
import { createPinsRouter, createPreferencesRouter, createSavedRouter } from "./modules/organization/organization.routes";
import { privacyRouter } from "./modules/privacy/privacy.routes";
import { createEventsRouter, createRemindersRouter, createTasksRouter } from "./modules/productivity/productivity.routes";
import { createScheduledMessagesRouter } from "./modules/scheduled-messages/scheduled-messages.routes";
import { createSessionsRouter } from "./modules/sessions/sessions.routes";
import { createStatusesRouter } from "./modules/statuses/statuses.routes";
import { createUsersRouter } from "./modules/users/users.routes";

export interface AppInstance {
  app: Express;
  container: Container;
}

export function createApp(overrides: ContainerOverrides = {}): AppInstance {
  const container = createContainer(overrides);
  const app = express();
  const limiters = createUserRateLimiters();

  // Behind a reverse proxy/load balancer, TRUST_PROXY makes req.ip the real
  // client address (rate limits would otherwise key on the proxy's IP).
  app.set("trust proxy", env.trustProxy);
  app.disable("x-powered-by");

  app.use(helmet());
  app.use(
    cors({
      origin: env.clientOrigins,
      credentials: true,
    })
  );
  app.use(express.json({ limit: "1mb" }));

  // Liveness: the process is up. Registered before the rate limiter so
  // load-balancer probes are never throttled.
  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok", service: "connectx-backend" });
  });
  // Readiness: the process can serve traffic (database reachable). No
  // internal details are returned either way.
  app.get("/health/ready", (_req, res) => {
    container.db.query("SELECT 1").then(
      () => res.status(200).json({ status: "ready" }),
      () => res.status(503).json({ status: "unavailable" })
    );
  });

  app.use(apiRateLimiter);

  const apiV1 = express.Router();
  // Auth routes come before the session guard: logging out (or refreshing)
  // must work even when the presented access token's session has ended.
  apiV1.use("/auth", createAuthRouter(container.authService));
  // Phase 6: every other request's bearer token must belong to an active (not revoked) session.
  apiV1.use(createSessionGuard(container.sessionsService));

  apiV1.use("/users", createUsersRouter(container.usersService, limiters.search));
  apiV1.use("/conversations", createConversationsRouter(container.conversationsService));
  apiV1.use("/messages", createMessagesRouter(container.messagesService, container.conversationsService, limiters.messages));
  apiV1.use("/groups", createGroupsRouter(container.groupsService));
  apiV1.use("/media", createMediaRouter(container.mediaService, container.maxUploadBytes, limiters.uploads));
  apiV1.use("/calls", createCallsRouter(container.callsService, limiters.callStarts));
  apiV1.use("/statuses", createStatusesRouter(container.statusesService, limiters.statuses));
  apiV1.use("/privacy", privacyRouter);
  apiV1.use("/ai", createAIRouter(container.ai));

  // --- Phase 6 ---
  apiV1.use("/notifications", createNotificationsRouter(container.notificationsService));
  apiV1.use("/sessions", createSessionsRouter(container.sessionsService));
  apiV1.use("/preferences", createPreferencesRouter(container.preferencesService, container.conversationAccess));
  apiV1.use("/tasks", createTasksRouter(container.tasksService));
  apiV1.use("/reminders", createRemindersRouter(container.remindersService));
  apiV1.use("/events", createEventsRouter(container.eventsService));
  apiV1.use("/notes", createNotesRouter(container.notesService));
  const todoRouters = createTodoRouters(container.todosService);
  apiV1.use("/todo-lists", todoRouters.lists);
  apiV1.use("/todo-items", todoRouters.items);
  apiV1.use("/pins", createPinsRouter(container.organizationService));
  apiV1.use("/saved", createSavedRouter(container.organizationService));
  apiV1.use("/scheduled-messages", createScheduledMessagesRouter(container.scheduledMessagesService));
  apiV1.use("/business", createBusinessRouter(container.businessService));

  app.use("/api/v1", apiV1);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return { app, container };
}
