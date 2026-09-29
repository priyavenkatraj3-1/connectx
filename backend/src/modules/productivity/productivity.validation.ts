import { z } from "zod";

const uuid = (field: string) => z.string().uuid(`${field} must be a valid ID`);

/** Absolute instant with an explicit offset, e.g. 2026-10-01T09:00:00Z or …+02:00. */
export const isoDateTime = z.string().datetime({ offset: true, message: "Must be an ISO-8601 date-time with a timezone offset" });
/** Wall-clock time, interpreted in `timezone` (or the user's preferred timezone) on the server. */
export const localDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/, "Must look like YYYY-MM-DDTHH:mm");
export const timezoneField = z.string().trim().min(1).max(64);

const priority = z.enum(["low", "medium", "high", "urgent"]);
const taskStatus = z.enum(["todo", "in_progress", "completed", "cancelled"]);

const sourceFields = {
  sourceConversationId: uuid("sourceConversationId").optional(),
  sourceMessageId: uuid("sourceMessageId").optional(),
  sourceActionId: uuid("sourceActionId").optional(),
};

export const createTaskSchema = z
  .object({
    title: z.string().trim().min(1, "Title is required").max(200),
    description: z.string().trim().max(2000).nullable().optional(),
    status: taskStatus.optional(),
    priority: priority.optional(),
    dueAt: isoDateTime.nullable().optional(),
    dueAtLocal: localDateTime.nullable().optional(),
    reminderAt: isoDateTime.nullable().optional(),
    reminderAtLocal: localDateTime.nullable().optional(),
    timezone: timezoneField.nullable().optional(),
    assigneeId: uuid("assigneeId").nullable().optional(),
    ...sourceFields,
  })
  .strict();

export const updateTaskSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    status: taskStatus.optional(),
    priority: priority.optional(),
    dueAt: isoDateTime.nullable().optional(),
    dueAtLocal: localDateTime.nullable().optional(),
    reminderAt: isoDateTime.nullable().optional(),
    reminderAtLocal: localDateTime.nullable().optional(),
    timezone: timezoneField.nullable().optional(),
    assigneeId: uuid("assigneeId").nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: "Nothing to update" });

export const listTasksQuerySchema = z.object({
  status: z.enum(["todo", "in_progress", "completed", "cancelled", "open"]).optional(),
  priority: priority.optional(),
  scope: z.enum(["all", "mine", "assigned"]).optional(),
  conversationId: uuid("conversationId").optional(),
  q: z.string().trim().max(100).optional(),
  dueBefore: isoDateTime.optional(),
  sort: z.enum(["due", "priority", "created", "updated"]).optional(),
  order: z.enum(["asc", "desc"]).optional(),
});

export const createReminderSchema = z
  .object({
    title: z.string().trim().min(1, "Title is required").max(200),
    notes: z.string().trim().max(1000).nullable().optional(),
    remindAt: isoDateTime.optional(),
    remindAtLocal: localDateTime.optional(),
    timezone: timezoneField.nullable().optional(),
    taskId: uuid("taskId").optional(),
    ...sourceFields,
  })
  .strict()
  .refine((value) => value.remindAt !== undefined || value.remindAtLocal !== undefined, {
    message: "remindAt or remindAtLocal is required",
    path: ["remindAt"],
  });

export const updateReminderSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    notes: z.string().trim().max(1000).nullable().optional(),
    remindAt: isoDateTime.optional(),
    remindAtLocal: localDateTime.optional(),
    timezone: timezoneField.nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: "Nothing to update" });

export const listRemindersQuerySchema = z.object({
  status: z.enum(["pending", "fired", "completed", "dismissed", "active"]).optional(),
});

export const createEventSchema = z
  .object({
    title: z.string().trim().min(1, "Title is required").max(200),
    description: z.string().trim().max(2000).nullable().optional(),
    location: z.string().trim().max(300).nullable().optional(),
    startsAt: isoDateTime.optional(),
    startsAtLocal: localDateTime.optional(),
    endsAt: isoDateTime.nullable().optional(),
    endsAtLocal: localDateTime.nullable().optional(),
    allDay: z.boolean().optional(),
    timezone: timezoneField.nullable().optional(),
    ...sourceFields,
  })
  .strict()
  .refine((value) => value.startsAt !== undefined || value.startsAtLocal !== undefined, {
    message: "startsAt or startsAtLocal is required",
    path: ["startsAt"],
  });

export const updateEventSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    location: z.string().trim().max(300).nullable().optional(),
    startsAt: isoDateTime.optional(),
    startsAtLocal: localDateTime.optional(),
    endsAt: isoDateTime.nullable().optional(),
    endsAtLocal: localDateTime.nullable().optional(),
    allDay: z.boolean().optional(),
    timezone: timezoneField.nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: "Nothing to update" });

export const listEventsQuerySchema = z.object({
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
});

export const idParamsSchema = z.object({ id: uuid("id") });

export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;
export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;
export type CreateReminderInput = z.infer<typeof createReminderSchema>;
export type UpdateReminderInput = z.infer<typeof updateReminderSchema>;
export type CreateEventInput = z.infer<typeof createEventSchema>;
export type UpdateEventInput = z.infer<typeof updateEventSchema>;
