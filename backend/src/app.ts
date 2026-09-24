import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import { env } from "./config/env";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import { apiRateLimiter } from "./middleware/rateLimiter";
import { aiRouter } from "./modules/ai/ai.routes";
import { authRouter } from "./modules/auth/auth.routes";
import { conversationsRouter } from "./modules/conversations/conversations.routes";
import { groupsRouter } from "./modules/groups/groups.routes";
import { mediaRouter } from "./modules/media/media.routes";
import { messagesRouter } from "./modules/messages/messages.routes";
import { notificationsRouter } from "./modules/notifications/notifications.routes";
import { privacyRouter } from "./modules/privacy/privacy.routes";
import { usersRouter } from "./modules/users/users.routes";

export function createApp(): Express {
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
  apiV1.use("/auth", authRouter);
  apiV1.use("/users", usersRouter);
  apiV1.use("/conversations", conversationsRouter);
  apiV1.use("/messages", messagesRouter);
  apiV1.use("/groups", groupsRouter);
  apiV1.use("/media", mediaRouter);
  apiV1.use("/notifications", notificationsRouter);
  apiV1.use("/privacy", privacyRouter);
  apiV1.use("/ai", aiRouter);

  app.use("/api/v1", apiV1);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
