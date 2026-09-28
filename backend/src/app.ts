import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import { type Container, type ContainerOverrides, createContainer } from "./container";
import { env } from "./config/env";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import { apiRateLimiter } from "./middleware/rateLimiter";
import { aiRouter } from "./modules/ai/ai.routes";
import { createAuthRouter } from "./modules/auth/auth.routes";
import { createConversationsRouter } from "./modules/conversations/conversations.routes";
import { createGroupsRouter } from "./modules/groups/groups.routes";
import { createMediaRouter } from "./modules/media/media.routes";
import { createMessagesRouter } from "./modules/messages/messages.routes";
import { notificationsRouter } from "./modules/notifications/notifications.routes";
import { privacyRouter } from "./modules/privacy/privacy.routes";
import { createUsersRouter } from "./modules/users/users.routes";

export interface AppInstance {
  app: Express;
  container: Container;
}

export function createApp(overrides: ContainerOverrides = {}): AppInstance {
  const container = createContainer(overrides);
  const app = express();

  app.use(helmet());
  app.use(
    cors({
      origin: env.clientOrigin,
      credentials: true,
    })
  );
  app.use(express.json({ limit: "1mb" }));
  app.use(apiRateLimiter);

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok", service: "connectx-backend" });
  });

  const apiV1 = express.Router();
  apiV1.use("/auth", createAuthRouter(container.authService));
  apiV1.use("/users", createUsersRouter(container.usersService));
  apiV1.use("/conversations", createConversationsRouter(container.conversationsService));
  apiV1.use("/messages", createMessagesRouter(container.messagesService, container.conversationsService));
  apiV1.use("/groups", createGroupsRouter(container.groupsService));
  apiV1.use("/media", createMediaRouter(container.mediaService, container.maxUploadBytes));
  apiV1.use("/notifications", notificationsRouter);
  apiV1.use("/privacy", privacyRouter);
  apiV1.use("/ai", aiRouter);

  app.use("/api/v1", apiV1);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return { app, container };
}
