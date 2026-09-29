import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useAuth } from "../../context/AuthContext";
import { useRealtime } from "../../context/RealtimeContext";
import { noteService, pinService, todoService } from "../../services/productivityService";
import type { PinnedMessage, SharedNote, TodoList, TodoListWithItems } from "../../types/productivity";
import { describeMessageContent } from "../../utils/conversationDisplay";
import { formatDateTime } from "../../utils/datetime";
import { ErrorLine, fieldClass, PriorityBadge } from "../productivity/shared";
import { ScheduledMessagesPanel } from "../productivity/ScheduledMessagesPanel";
import { TaskPanel } from "../productivity/TaskPanel";
import { Button } from "../ui/Button";
import { CloseIcon, TrashIcon } from "../ui/icons";

type Tab = "pinned" | "notes" | "todo" | "tasks" | "scheduled";

interface ConversationToolsPanelProps {
  conversationId: string;
  isGroup: boolean;
  /** Can the current user pin/unpin here (anyone in direct chats; owner/admins in groups)? Mirrors the server rule. */
  canPin: boolean;
  members: Array<{ userId: string; displayName: string }>;
  initialTab?: Tab;
  onJumpToMessage(messageId: string): void;
  onClose(): void;
}

/**
 * Per-conversation collaboration: pinned messages, shared notes, shared
 * to-do lists, this chat's tasks, and your scheduled messages. The server
 * checks conversation membership on every request; these views only
 * reflect what it returns.
 */
export function ConversationToolsPanel({ conversationId, isGroup, canPin, members, initialTab = "pinned", onJumpToMessage, onClose }: ConversationToolsPanelProps) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "pinned", label: "Pinned" },
    { id: "notes", label: "Notes" },
    { id: "todo", label: "To-do" },
    { id: "tasks", label: "Tasks" },
    { id: "scheduled", label: "Scheduled" },
  ];

  return (
    <aside className="flex w-full flex-col border-l border-slate-200 bg-white dark:border-slate-800 dark:bg-surface-dark md:w-96" aria-label="Chat tools">
      <header className="flex items-center gap-2 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <h2 className="flex-1 text-sm font-semibold text-slate-900 dark:text-slate-100">Chat tools</h2>
        <button type="button" onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Close chat tools">
          <CloseIcon width={18} height={18} />
        </button>
      </header>
      <div className="flex gap-1 overflow-x-auto border-b border-slate-100 px-2 dark:border-slate-800" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`whitespace-nowrap px-2.5 py-2 text-sm font-medium ${tab === t.id ? "border-b-2 border-brand-600 text-brand-700 dark:text-brand-300" : "text-slate-500"}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        {tab === "pinned" && <PinnedList conversationId={conversationId} canPin={canPin} onJump={onJumpToMessage} />}
        {tab === "notes" && <NotesList conversationId={conversationId} isGroup={isGroup} />}
        {tab === "todo" && <TodoLists conversationId={conversationId} members={members} />}
        {tab === "tasks" && <TaskPanel conversationId={conversationId} />}
        {tab === "scheduled" && <ScheduledMessagesPanel conversationId={conversationId} />}
      </div>
    </aside>
  );
}

function PinnedList({ conversationId, canPin, onJump }: { conversationId: string; canPin: boolean; onJump(messageId: string): void }) {
  const { accessToken } = useAuth();
  const { subscribe } = useRealtime();
  const [pins, setPins] = useState<PinnedMessage[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accessToken) return;
    try {
      setPins(await pinService.list(accessToken, conversationId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load pinned messages");
    }
  }, [accessToken, conversationId]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(
    () =>
      subscribe((event) => {
        if ((event.type === "message:pinned" || event.type === "message:unpinned" || event.type === "message:deleted") && event.conversationId === conversationId) void load();
      }),
    [subscribe, load, conversationId]
  );

  return (
    <div className="space-y-2">
      <ErrorLine message={error} />
      {pins.length === 0 && <p className="py-6 text-center text-sm text-slate-400">No pinned messages. {canPin ? "Pin one from a message’s menu." : "Group admins can pin messages."}</p>}
      <ul className="space-y-2" aria-label="Pinned messages">
        {pins.map((pin) => (
          <li key={pin.messageId} className="rounded-lg border border-slate-200 p-2.5 text-sm dark:border-slate-700">
            <button type="button" className="w-full text-left" onClick={() => onJump(pin.messageId)}>
              <p className="text-xs font-semibold text-brand-600 dark:text-brand-300">{pin.message.senderDisplayName}</p>
              <p className="line-clamp-3 text-slate-800 dark:text-slate-100">{describeMessageContent(pin.message.contentType, pin.message.body) || "Message"}</p>
            </button>
            <div className="mt-1 flex items-center justify-between text-[11px] text-slate-400">
              <span>Pinned {pin.pinnedBy ? `by ${pin.pinnedBy.displayName}` : ""} · {formatDateTime(pin.pinnedAt)}</span>
              {canPin && accessToken && (
                <button
                  type="button"
                  className="font-medium text-slate-500 hover:text-red-600"
                  onClick={async () => {
                    try {
                      await pinService.unpin(accessToken, pin.messageId);
                      await load();
                    } catch (err) {
                      setError(err instanceof Error ? err.message : "Couldn't unpin");
                    }
                  }}
                >
                  Unpin
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function NotesList({ conversationId, isGroup }: { conversationId: string; isGroup: boolean }) {
  const { accessToken } = useAuth();
  const { subscribe } = useRealtime();
  const [notes, setNotes] = useState<SharedNote[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ title: string; content: string; version: number } | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accessToken) return;
    try {
      setNotes(await noteService.list(accessToken, conversationId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load notes");
    }
  }, [accessToken, conversationId]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(
    () => subscribe((event) => ((event.type === "note:updated" || event.type === "note:deleted") && event.conversationId === conversationId ? void load() : undefined)),
    [subscribe, load, conversationId]
  );

  const open = notes.find((n) => n.id === openId) ?? null;
  // Someone else saved while we were editing: the server will reject our stale save (409) — tell the user early.
  const changedElsewhere = !!open && !!draft && open.version !== draft.version;

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!accessToken || !newTitle.trim()) return;
    try {
      const note = await noteService.create(accessToken, { conversationId, title: newTitle.trim() });
      setNewTitle("");
      await load();
      setOpenId(note.id);
      setDraft({ title: note.title, content: note.content, version: note.version });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create note");
    }
  }

  return (
    <div className="space-y-3">
      <form onSubmit={create} className="flex gap-2">
        <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="New note title" maxLength={200} className={fieldClass} aria-label="New note title" />
        <Button type="submit" disabled={!newTitle.trim()} className="py-2">
          Add
        </Button>
      </form>
      <ErrorLine message={error} />
      {open && draft ? (
        <div className="space-y-2">
          <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} disabled={!open.canEdit} maxLength={200} className={fieldClass} aria-label="Note title" />
          <textarea value={draft.content} onChange={(e) => setDraft({ ...draft, content: e.target.value })} disabled={!open.canEdit} rows={10} maxLength={20000} className={fieldClass} aria-label="Note content" />
          <p className="text-[11px] text-slate-400">
            Last edited by {open.updatedBy?.displayName ?? open.createdBy.displayName} · {formatDateTime(open.updatedAt)}
            {!open.canEdit && " · Only group admins can edit this note"}
          </p>
          {changedElsewhere && <p className="text-xs text-amber-600">Someone else changed this note. Reopen it to see their version before saving.</p>}
          {isGroup && open.canDelete && (
            <label className="flex items-center gap-2 text-xs text-slate-500">
              <input
                type="checkbox"
                checked={open.editPolicy === "admins"}
                onChange={async (e) => {
                  if (!accessToken) return;
                  try {
                    const updated = await noteService.update(accessToken, open.id, { editPolicy: e.target.checked ? "admins" : "members" });
                    setDraft({ ...draft, version: updated.version });
                    await load();
                  } catch (err) {
                    setError(err instanceof Error ? err.message : "Couldn't change who can edit");
                  }
                }}
              />
              Only admins can edit
            </label>
          )}
          <div className="flex gap-2">
            {open.canEdit && (
              <Button
                className="py-1.5"
                disabled={!draft.title.trim()}
                onClick={async () => {
                  if (!accessToken) return;
                  try {
                    const updated = await noteService.update(accessToken, open.id, { title: draft.title.trim(), content: draft.content, expectedVersion: draft.version });
                    setDraft({ title: updated.title, content: updated.content, version: updated.version });
                    await load();
                  } catch (err) {
                    setError(err instanceof Error ? err.message : "Couldn't save note");
                  }
                }}
              >
                Save
              </Button>
            )}
            <Button variant="ghost" className="py-1.5" onClick={() => { setOpenId(null); setDraft(null); }}>
              Close
            </Button>
            {open.canDelete && (
              <Button
                variant="ghost"
                className="ml-auto py-1.5 text-red-600"
                onClick={async () => {
                  if (!accessToken) return;
                  await noteService.remove(accessToken, open.id).catch((err: unknown) => setError(err instanceof Error ? err.message : "Couldn't delete"));
                  setOpenId(null);
                  setDraft(null);
                  await load();
                }}
              >
                Delete
              </Button>
            )}
          </div>
        </div>
      ) : (
        <ul className="space-y-1" aria-label="Shared notes">
          {notes.length === 0 && <li className="py-6 text-center text-sm text-slate-400">No shared notes yet.</li>}
          {notes.map((note) => (
            <li key={note.id}>
              <button
                type="button"
                className="w-full rounded-lg px-2 py-2 text-left hover:bg-slate-100 dark:hover:bg-slate-800"
                onClick={() => {
                  setOpenId(note.id);
                  setDraft({ title: note.title, content: note.content, version: note.version });
                }}
              >
                <p className="text-sm font-medium text-slate-900 dark:text-slate-100">{note.title}</p>
                <p className="truncate text-xs text-slate-500">{note.content || "Empty note"}</p>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TodoLists({ conversationId, members }: { conversationId: string; members: Array<{ userId: string; displayName: string }> }) {
  const { accessToken } = useAuth();
  const { subscribe } = useRealtime();
  const [lists, setLists] = useState<TodoList[]>([]);
  const [open, setOpen] = useState<TodoListWithItems | null>(null);
  const [newList, setNewList] = useState("");
  const [newItem, setNewItem] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accessToken) return;
    try {
      setLists(await todoService.lists(accessToken, conversationId));
      if (open) setOpen(await todoService.get(accessToken, open.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load to-do lists");
      if (open) setOpen(null);
    }
  }, [accessToken, conversationId, open?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(
    () => subscribe((event) => (event.type.startsWith("todo:") && "conversationId" in event && event.conversationId === conversationId ? void load() : undefined)),
    [subscribe, load, conversationId]
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

  if (open && accessToken) {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <button type="button" className="text-xs font-medium text-brand-600" onClick={() => setOpen(null)}>
            ← All lists
          </button>
          <button type="button" className="text-xs text-slate-400 hover:text-red-600" onClick={() => void run(async () => { await todoService.removeList(accessToken, open.id); setOpen(null); })}>
            Delete list
          </button>
        </div>
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{open.title}</h3>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!newItem.trim()) return;
            void run(async () => {
              await todoService.addItem(accessToken, open.id, { title: newItem.trim() });
              setNewItem("");
            });
          }}
          className="flex gap-2"
        >
          <input value={newItem} onChange={(e) => setNewItem(e.target.value)} placeholder="Add an item" maxLength={200} className={fieldClass} aria-label="New to-do item" />
          <Button type="submit" disabled={!newItem.trim()} className="py-2">
            Add
          </Button>
        </form>
        <ErrorLine message={error} />
        <ul className="space-y-1" aria-label="To-do items">
          {open.items.map((item) => (
            <li key={item.id} className="flex items-start gap-2 rounded-lg px-1 py-1.5">
              <input
                type="checkbox"
                checked={item.completed}
                onChange={() => void run(() => todoService.setCompleted(accessToken, item.id, !item.completed))}
                className="mt-1 h-4 w-4 accent-brand-600"
                aria-label={item.completed ? `Reopen ${item.title}` : `Complete ${item.title}`}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className={`text-sm ${item.completed ? "text-slate-400 line-through" : "text-slate-900 dark:text-slate-100"}`}>{item.title}</p>
                  {item.priority !== "medium" && <PriorityBadge priority={item.priority} />}
                </div>
                <div className="flex items-center gap-2 text-[11px] text-slate-500">
                  <select
                    value={item.assignee?.id ?? ""}
                    onChange={(e) => void run(() => todoService.updateItem(accessToken, item.id, { assigneeId: e.target.value || null }))}
                    className="rounded bg-transparent py-0.5 text-[11px]"
                    aria-label={`Assign ${item.title}`}
                  >
                    <option value="">Unassigned</option>
                    {members.map((m) => (
                      <option key={m.userId} value={m.userId}>
                        {m.displayName}
                      </option>
                    ))}
                  </select>
                  {item.dueAt && <span>Due {formatDateTime(item.dueAt)}</span>}
                </div>
              </div>
              <button type="button" onClick={() => void run(() => todoService.removeItem(accessToken, item.id))} className="text-slate-300 hover:text-red-600" aria-label={`Delete ${item.title}`}>
                <TrashIcon width={14} height={14} />
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!accessToken || !newList.trim()) return;
          void run(async () => {
            await todoService.createList(accessToken, conversationId, newList.trim());
            setNewList("");
          });
        }}
        className="flex gap-2"
      >
        <input value={newList} onChange={(e) => setNewList(e.target.value)} placeholder="New list (e.g. Groceries)" maxLength={120} className={fieldClass} aria-label="New to-do list" />
        <Button type="submit" disabled={!newList.trim()} className="py-2">
          Create
        </Button>
      </form>
      <ErrorLine message={error} />
      <ul className="space-y-1" aria-label="To-do lists">
        {lists.length === 0 && <li className="py-6 text-center text-sm text-slate-400">No shared to-do lists yet.</li>}
        {lists.map((list) => (
          <li key={list.id}>
            <button
              type="button"
              className="flex w-full items-center justify-between rounded-lg px-2 py-2 text-left hover:bg-slate-100 dark:hover:bg-slate-800"
              onClick={() => accessToken && void todoService.get(accessToken, list.id).then(setOpen, (err: unknown) => setError(err instanceof Error ? err.message : "Couldn't open list"))}
            >
              <span className="text-sm font-medium text-slate-900 dark:text-slate-100">{list.title}</span>
              <span className="text-xs text-slate-400">
                {list.completedCount}/{list.itemCount} done
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
