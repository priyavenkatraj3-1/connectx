import { Router, type Response } from "express";
import { z } from "zod";
import { requireAuth, type AuthenticatedRequest } from "../../middleware/requireAuth";
import { validateBody, validateParams, validateQuery } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import type { SharedNotesService } from "./notes.service";
import type { SharedTodosService } from "./todos.service";

const uuid = (field: string) => z.string().uuid(`${field} must be a valid ID`);
const priority = z.enum(["low", "medium", "high", "urgent"]);
const isoDateTime = z.string().datetime({ offset: true, message: "Must be an ISO-8601 date-time with a timezone offset" });

export const conversationQuerySchema = z.object({ conversationId: uuid("conversationId") });
export const idParamsSchema = z.object({ id: uuid("id") });

export const createNoteSchema = z
  .object({
    conversationId: uuid("conversationId"),
    title: z.string().trim().min(1, "Title is required").max(200),
    content: z.string().max(20000, "Note is too long").optional(),
    editPolicy: z.enum(["members", "admins"]).optional(),
  })
  .strict();

export const updateNoteSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    content: z.string().max(20000, "Note is too long").optional(),
    editPolicy: z.enum(["members", "admins"]).optional(),
    expectedVersion: z.number().int().min(1).optional(),
  })
  .strict()
  .refine((v) => v.title !== undefined || v.content !== undefined || v.editPolicy !== undefined, { message: "Nothing to update" });

export const createListSchema = z.object({ conversationId: uuid("conversationId"), title: z.string().trim().min(1).max(120) }).strict();
export const renameListSchema = z.object({ title: z.string().trim().min(1).max(120) }).strict();

const itemFields = {
  notes: z.string().trim().max(1000).nullable().optional(),
  assigneeId: uuid("assigneeId").nullable().optional(),
  priority: priority.optional(),
  dueAt: isoDateTime.nullable().optional(),
};
export const createItemSchema = z.object({ title: z.string().trim().min(1, "Title is required").max(200), ...itemFields }).strict();
export const updateItemSchema = z
  .object({ title: z.string().trim().min(1).max(200).optional(), ...itemFields })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to update" });

type Handler = (req: AuthenticatedRequest, res: Response) => Promise<void>;
const handle = (fn: Handler) => asyncHandler(fn as Parameters<typeof asyncHandler>[0]);
const userId = (req: AuthenticatedRequest) => req.user!.userId;
const id = (req: AuthenticatedRequest) => req.params.id as string;
const idParams = validateParams(idParamsSchema);

/** /api/v1/notes — conversation membership is checked in SharedNotesService on every call. */
export function createNotesRouter(notes: SharedNotesService): Router {
  const router = Router();
  router.use(requireAuth);

  router.get(
    "/",
    validateQuery(conversationQuerySchema),
    handle(async (req, res) => {
      const { conversationId } = conversationQuerySchema.parse(req.query);
      res.json({ notes: await notes.list(conversationId, userId(req)) });
    })
  );
  router.post(
    "/",
    validateBody(createNoteSchema),
    handle(async (req, res) => void res.status(201).json({ note: await notes.create(userId(req), req.body) }))
  );
  router.get("/:id", idParams, handle(async (req, res) => void res.json({ note: await notes.get(id(req), userId(req)) })));
  router.patch(
    "/:id",
    idParams,
    validateBody(updateNoteSchema),
    handle(async (req, res) => void res.json({ note: await notes.update(id(req), userId(req), req.body) }))
  );
  router.delete(
    "/:id",
    idParams,
    handle(async (req, res) => {
      await notes.remove(id(req), userId(req));
      res.status(204).send();
    })
  );
  return router;
}

/** /api/v1/todo-lists and /api/v1/todo-items — membership is checked in SharedTodosService on every call. */
export function createTodoRouters(todos: SharedTodosService): { lists: Router; items: Router } {
  const lists = Router();
  lists.use(requireAuth);
  lists.get(
    "/",
    validateQuery(conversationQuerySchema),
    handle(async (req, res) => {
      const { conversationId } = conversationQuerySchema.parse(req.query);
      res.json({ lists: await todos.listForConversation(conversationId, userId(req)) });
    })
  );
  lists.post(
    "/",
    validateBody(createListSchema),
    handle(async (req, res) => {
      const { conversationId, title } = req.body as z.infer<typeof createListSchema>;
      res.status(201).json({ list: await todos.createList(userId(req), conversationId, title) });
    })
  );
  lists.get("/:id", idParams, handle(async (req, res) => void res.json({ list: await todos.getList(id(req), userId(req)) })));
  lists.patch(
    "/:id",
    idParams,
    validateBody(renameListSchema),
    handle(async (req, res) => void res.json({ list: await todos.renameList(id(req), userId(req), req.body.title as string) }))
  );
  lists.delete(
    "/:id",
    idParams,
    handle(async (req, res) => {
      await todos.deleteList(id(req), userId(req));
      res.status(204).send();
    })
  );
  lists.post(
    "/:id/items",
    idParams,
    validateBody(createItemSchema),
    handle(async (req, res) => void res.status(201).json({ item: await todos.addItem(id(req), userId(req), req.body) }))
  );

  const items = Router();
  items.use(requireAuth);
  items.patch(
    "/:id",
    idParams,
    validateBody(updateItemSchema),
    handle(async (req, res) => void res.json({ item: await todos.updateItem(id(req), userId(req), req.body) }))
  );
  items.post("/:id/complete", idParams, handle(async (req, res) => void res.json({ item: await todos.setCompleted(id(req), userId(req), true) })));
  items.post("/:id/reopen", idParams, handle(async (req, res) => void res.json({ item: await todos.setCompleted(id(req), userId(req), false) })));
  items.delete(
    "/:id",
    idParams,
    handle(async (req, res) => {
      await todos.deleteItem(id(req), userId(req));
      res.status(204).send();
    })
  );
  return { lists, items };
}
