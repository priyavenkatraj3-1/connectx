import { Router, type Response } from "express";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/requireAuth";
import { validateBody, validateParams, validateQuery } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import type { EventsService } from "./events.service";
import {
  createEventSchema,
  createReminderSchema,
  createTaskSchema,
  idParamsSchema,
  listEventsQuerySchema,
  listRemindersQuerySchema,
  listTasksQuerySchema,
  updateEventSchema,
  updateReminderSchema,
  updateTaskSchema,
  type CreateEventInput,
  type CreateReminderInput,
  type CreateTaskInput,
  type UpdateEventInput,
  type UpdateReminderInput,
  type UpdateTaskInput,
} from "./productivity.validation";
import type { RemindersService } from "./reminders.service";
import type { TasksService } from "./tasks.service";

type Handler = (req: AuthenticatedRequest, res: Response) => Promise<void>;
const handle = (fn: Handler) => asyncHandler(fn as Parameters<typeof asyncHandler>[0]);
const userId = (req: AuthenticatedRequest) => req.user!.userId;
const id = (req: AuthenticatedRequest) => req.params.id as string;
const idParams = validateParams(idParamsSchema);

/** /api/v1/tasks — ownership/assignee authorization lives in TasksService. */
export function createTasksRouter(tasks: TasksService): Router {
  const router = Router();
  router.use(requireAuth);

  router.get(
    "/",
    validateQuery(listTasksQuerySchema),
    handle(async (req, res) => {
      res.json({ tasks: await tasks.list(userId(req), listTasksQuerySchema.parse(req.query)) });
    })
  );
  router.post(
    "/",
    validateBody(createTaskSchema),
    handle(async (req, res) => {
      res.status(201).json({ task: await tasks.create(userId(req), req.body as CreateTaskInput) });
    })
  );
  router.get("/:id", idParams, handle(async (req, res) => void res.json({ task: await tasks.get(userId(req), id(req)) })));
  router.patch(
    "/:id",
    idParams,
    validateBody(updateTaskSchema),
    handle(async (req, res) => {
      res.json({ task: await tasks.update(userId(req), id(req), req.body as UpdateTaskInput) });
    })
  );
  router.post("/:id/complete", idParams, handle(async (req, res) => void res.json({ task: await tasks.complete(userId(req), id(req)) })));
  router.post("/:id/reopen", idParams, handle(async (req, res) => void res.json({ task: await tasks.reopen(userId(req), id(req)) })));
  router.delete(
    "/:id",
    idParams,
    handle(async (req, res) => {
      await tasks.remove(userId(req), id(req));
      res.status(204).send();
    })
  );
  return router;
}

/** /api/v1/reminders — private to the owner. */
export function createRemindersRouter(reminders: RemindersService): Router {
  const router = Router();
  router.use(requireAuth);

  router.get(
    "/",
    validateQuery(listRemindersQuerySchema),
    handle(async (req, res) => {
      const { status } = listRemindersQuerySchema.parse(req.query);
      res.json({ reminders: await reminders.list(userId(req), status) });
    })
  );
  router.post(
    "/",
    validateBody(createReminderSchema),
    handle(async (req, res) => {
      res.status(201).json({ reminder: await reminders.create(userId(req), req.body as CreateReminderInput) });
    })
  );
  router.patch(
    "/:id",
    idParams,
    validateBody(updateReminderSchema),
    handle(async (req, res) => {
      res.json({ reminder: await reminders.update(userId(req), id(req), req.body as UpdateReminderInput) });
    })
  );
  router.post(
    "/:id/complete",
    idParams,
    handle(async (req, res) => void res.json({ reminder: await reminders.setStatus(userId(req), id(req), "completed") }))
  );
  router.post(
    "/:id/dismiss",
    idParams,
    handle(async (req, res) => void res.json({ reminder: await reminders.setStatus(userId(req), id(req), "dismissed") }))
  );
  router.delete(
    "/:id",
    idParams,
    handle(async (req, res) => {
      await reminders.remove(userId(req), id(req));
      res.status(204).send();
    })
  );
  return router;
}

/** /api/v1/events — private calendar events. */
export function createEventsRouter(events: EventsService): Router {
  const router = Router();
  router.use(requireAuth);

  router.get(
    "/",
    validateQuery(listEventsQuerySchema),
    handle(async (req, res) => {
      res.json({ events: await events.list(userId(req), listEventsQuerySchema.parse(req.query)) });
    })
  );
  router.post(
    "/",
    validateBody(createEventSchema),
    handle(async (req, res) => {
      res.status(201).json({ event: await events.create(userId(req), req.body as CreateEventInput) });
    })
  );
  router.get("/:id", idParams, handle(async (req, res) => void res.json({ event: await events.get(userId(req), id(req)) })));
  router.patch(
    "/:id",
    idParams,
    validateBody(updateEventSchema),
    handle(async (req, res) => {
      res.json({ event: await events.update(userId(req), id(req), req.body as UpdateEventInput) });
    })
  );
  router.delete(
    "/:id",
    idParams,
    handle(async (req, res) => {
      await events.remove(userId(req), id(req));
      res.status(204).send();
    })
  );
  return router;
}
