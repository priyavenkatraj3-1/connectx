import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useAuth } from "../../context/AuthContext";
import { useRealtime } from "../../context/RealtimeContext";
import { useOptionalWorkspace } from "../../context/WorkspaceContext";
import { taskService, type TaskQuery } from "../../services/productivityService";
import type { Priority, Task } from "../../types/productivity";
import { browserTimezone, formatDateTime, isPast, toLocalInputValue } from "../../utils/datetime";
import { Button } from "../ui/Button";
import { TrashIcon } from "../ui/icons";
import { ErrorLine, fieldClass, PRIORITY_LABEL, PriorityBadge, SourceLink } from "./shared";

type StatusFilter = "open" | "completed" | "all";

function matches(task: Task, status: StatusFilter): boolean {
  if (status === "open") return task.status === "todo" || task.status === "in_progress";
  if (status === "completed") return task.status === "completed";
  return true;
}

/** The task list: quick add, filter, sort, complete/reopen, edit, delete. Kept live by task:* realtime events. */
export function TaskPanel({ conversationId }: { conversationId?: string }) {
  const { accessToken, user } = useAuth();
  const { subscribe } = useRealtime();
  const timezone = useOptionalWorkspace()?.timezone ?? browserTimezone();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [status, setStatus] = useState<StatusFilter>("open");
  const [scope, setScope] = useState<NonNullable<TaskQuery["scope"]>>("all");
  const [sort, setSort] = useState<NonNullable<TaskQuery["sort"]>>("due");
  const [search, setSearch] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [newDue, setNewDue] = useState("");
  const [newPriority, setNewPriority] = useState<Priority>("medium");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!accessToken) return;
    try {
      const query: TaskQuery = { scope, sort, conversationId, q: search.trim() || undefined };
      if (status !== "all") query.status = status;
      setTasks(await taskService.list(accessToken, query));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load tasks");
    } finally {
      setLoading(false);
    }
  }, [accessToken, scope, sort, status, search, conversationId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(
    () =>
      subscribe((event) => {
        if (event.type === "task:updated") {
          // Re-query so filters and sort order stay correct.
          void load();
        } else if (event.type === "task:deleted") {
          setTasks((prev) => prev.filter((t) => t.id !== event.taskId));
        }
      }),
    [subscribe, load]
  );

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    }
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!accessToken || !newTitle.trim()) return;
    await run(() =>
      taskService.create(accessToken, {
        title: newTitle.trim(),
        priority: newPriority,
        dueAtLocal: newDue || null,
        timezone,
        ...(conversationId ? { sourceConversationId: conversationId } : {}),
      })
    );
    setNewTitle("");
    setNewDue("");
  }

  const visible = tasks.filter((t) => matches(t, status));

  return (
    <div className="space-y-3">
      <form onSubmit={add} className="flex flex-wrap items-end gap-2" aria-label="Add task">
        <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="Add a task…" maxLength={200} className={`${fieldClass} min-w-40 flex-1`} aria-label="New task title" />
        <input type="datetime-local" value={newDue} onChange={(e) => setNewDue(e.target.value)} className={`${fieldClass} w-auto`} aria-label="New task due date" />
        <select value={newPriority} onChange={(e) => setNewPriority(e.target.value as Priority)} className={`${fieldClass} w-auto`} aria-label="New task priority">
          {(Object.keys(PRIORITY_LABEL) as Priority[]).map((p) => (
            <option key={p} value={p}>
              {PRIORITY_LABEL[p]}
            </option>
          ))}
        </select>
        <Button type="submit" disabled={!newTitle.trim()} className="py-2">
          Add
        </Button>
      </form>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} className={`${fieldClass} w-auto py-1`} aria-label="Status filter">
          <option value="open">Open</option>
          <option value="completed">Completed</option>
          <option value="all">All</option>
        </select>
        <select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)} className={`${fieldClass} w-auto py-1`} aria-label="Whose tasks">
          <option value="all">Mine & assigned to me</option>
          <option value="mine">Created by me</option>
          <option value="assigned">Assigned to me</option>
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} className={`${fieldClass} w-auto py-1`} aria-label="Sort by">
          <option value="due">Due date</option>
          <option value="priority">Priority</option>
          <option value="created">Newest</option>
          <option value="updated">Recently updated</option>
        </select>
        <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search tasks" className={`${fieldClass} w-40 py-1`} aria-label="Search tasks" />
      </div>

      <ErrorLine message={error} />
      {!loading && visible.length === 0 && <p className="py-6 text-center text-sm text-slate-400">No tasks here.</p>}

      <ul className="divide-y divide-slate-100 dark:divide-slate-800" aria-label="Tasks">
        {visible.map((task) => {
          const done = task.status === "completed";
          const isOwner = task.ownerId === user?.id;
          const overdue = !done && isPast(task.dueAt);
          return (
            <li key={task.id} className="flex items-start gap-3 py-2.5">
              <input
                type="checkbox"
                checked={done}
                onChange={() => accessToken && void run(() => (done ? taskService.reopen(accessToken, task.id) : taskService.complete(accessToken, task.id)))}
                className="mt-1 h-4 w-4 accent-brand-600"
                aria-label={done ? `Reopen ${task.title}` : `Complete ${task.title}`}
              />
              <div className="min-w-0 flex-1">
                {editingId === task.id && isOwner ? (
                  <TaskEditor task={task} timezone={timezone} onCancel={() => setEditingId(null)} onSave={(update) => accessToken && run(async () => {
                    await taskService.update(accessToken, task.id, update);
                    setEditingId(null);
                  })} />
                ) : (
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      <p className={`text-sm font-medium ${done ? "text-slate-400 line-through" : "text-slate-900 dark:text-slate-100"}`}>{task.title}</p>
                      <PriorityBadge priority={task.priority} />
                      {task.status === "in_progress" && <span className="text-[11px] text-brand-600">In progress</span>}
                    </div>
                    <p className="text-xs text-slate-500">
                      {task.dueAt && <span className={overdue ? "font-semibold text-red-600" : ""}>Due {formatDateTime(task.dueAt, timezone)}</span>}
                      {task.assignee && task.assignee.id !== user?.id && <span> · Assigned to {task.assignee.displayName}</span>}
                      {!isOwner && <span> · From {task.owner.displayName}</span>}
                    </p>
                    {task.description && <p className="mt-0.5 whitespace-pre-wrap text-xs text-slate-500">{task.description}</p>}
                    <SourceLink excerpt={task.source.messageExcerpt} conversationId={conversationId ? null : task.source.conversationId} />
                  </>
                )}
              </div>
              {editingId !== task.id && (
                <div className="flex shrink-0 items-center gap-1 text-xs">
                  {!done && task.status !== "in_progress" && accessToken && (
                    <button type="button" onClick={() => void run(() => taskService.update(accessToken, task.id, { status: "in_progress" }))} className="text-slate-500 hover:text-brand-600">
                      Start
                    </button>
                  )}
                  {isOwner && (
                    <>
                      <button type="button" onClick={() => setEditingId(task.id)} className="text-slate-500 hover:text-brand-600">
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => accessToken && void run(() => taskService.remove(accessToken, task.id))}
                        className="flex h-7 w-7 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-red-600 dark:hover:bg-slate-800"
                        aria-label={`Delete ${task.title}`}
                      >
                        <TrashIcon width={15} height={15} />
                      </button>
                    </>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function TaskEditor({
  task,
  timezone,
  onSave,
  onCancel,
}: {
  task: Task;
  timezone: string;
  onSave(update: { title: string; priority: Priority; dueAtLocal: string | null; description: string | null; timezone: string }): unknown;
  onCancel(): void;
}) {
  const [title, setTitle] = useState(task.title);
  const [priority, setPriority] = useState<Priority>(task.priority);
  const [due, setDue] = useState(task.dueAt ? toLocalInputValue(task.dueAt, timezone) : "");
  const [description, setDescription] = useState(task.description ?? "");
  return (
    <div className="space-y-2">
      <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} className={fieldClass} aria-label="Task title" />
      <div className="flex gap-2">
        <input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} className={fieldClass} aria-label="Task due date" />
        <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)} className={`${fieldClass} w-auto`} aria-label="Task priority">
          {(Object.keys(PRIORITY_LABEL) as Priority[]).map((p) => (
            <option key={p} value={p}>
              {PRIORITY_LABEL[p]}
            </option>
          ))}
        </select>
      </div>
      <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={2000} className={fieldClass} aria-label="Task details" />
      <div className="flex gap-2 text-xs font-medium">
        <button
          type="button"
          disabled={!title.trim()}
          onClick={() => onSave({ title: title.trim(), priority, dueAtLocal: due || null, description: description.trim() || null, timezone })}
          className="text-brand-600"
        >
          Save
        </button>
        <button type="button" onClick={onCancel} className="text-slate-500">
          Cancel
        </button>
      </div>
    </div>
  );
}
