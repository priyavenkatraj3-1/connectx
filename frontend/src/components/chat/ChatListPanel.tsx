import { useState } from "react";
import { NavLink, useParams } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { useConversations } from "../../context/ConversationsContext";
import { useOptionalWorkspace } from "../../context/WorkspaceContext";
import type { ConversationSummary } from "../../types/conversation";
import { EmptyState } from "../common/EmptyState";
import { ErrorState } from "../common/ErrorState";
import { LoadingState } from "../common/LoadingState";
import { Avatar } from "../ui/Avatar";
import { NewGroupModal } from "../groups/NewGroupModal";
import { BellIcon, ChatIcon, PinIcon, PlusIcon, SearchIcon, UsersIcon } from "../ui/icons";
import { ChatRowMenu } from "./ChatRowMenu";
import { NewConversationModal } from "./NewConversationModal";
import { formatTimestamp } from "../../utils/formatTime";
import {
  formatLastMessagePreview,
  getConversationAvatarUrl,
  getConversationTitle,
} from "../../utils/conversationDisplay";
import { describeMute, isMuted, pinnedFirst } from "../../utils/chatPreferences";

type ListFilter = "all" | "unread" | "groups" | "direct";

const LIST_FILTERS: Array<{ id: ListFilter; label: string; test(c: ConversationSummary): boolean }> = [
  { id: "all", label: "All", test: () => true },
  { id: "unread", label: "Unread", test: (c) => c.unreadCount > 0 },
  { id: "groups", label: "Groups", test: (c) => c.type === "group" },
  { id: "direct", label: "Direct", test: (c) => c.type === "direct" },
];

export function ChatListPanel() {
  const { user } = useAuth();
  const { conversations, isLoading, error, refresh, isShowingCached, updatePreferences } = useConversations();
  const { conversationId: activeConversationId } = useParams();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isGroupModalOpen, setIsGroupModalOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [view, setView] = useState<ListFilter>("all");
  const [showArchived, setShowArchived] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const workspace = useOptionalWorkspace();

  // Archived chats live in their own view; pinned chats come first (newest activity first within each).
  const archivedCount = conversations.filter((c) => c.archived).length;
  const visible = pinnedFirst(
    conversations
      .filter((c) => !!c.archived === showArchived)
      .filter((c) => getConversationTitle(c).toLowerCase().includes(filter.trim().toLowerCase()))
      .filter((c) => LIST_FILTERS.find((f) => f.id === view)!.test(c))
  );

  // Productivity Mode (Phase 6): the same conversations, grouped — focused first, then unread, then the rest. Nothing is hidden.
  const productivityMode = !!workspace?.preferences?.productivityMode;
  const focusedIds = new Set(workspace?.focusedConversationIds ?? []);
  const sections: Array<{ title: string | null; items: typeof visible }> = productivityMode
    ? [
        { title: "Focused", items: visible.filter((c) => focusedIds.has(c.id)) },
        { title: "Unread", items: visible.filter((c) => !focusedIds.has(c.id) && c.unreadCount > 0) },
        { title: "Everything else", items: visible.filter((c) => !focusedIds.has(c.id) && c.unreadCount === 0) },
      ].filter((section) => section.items.length > 0)
    : [{ title: null, items: visible }];

  return (
    <div
      className={`w-full flex-col border-r border-slate-200 dark:border-slate-800 md:flex md:w-96 ${
        activeConversationId ? "hidden" : "flex"
      }`}
    >
      <div className="flex items-center justify-between px-4 py-4">
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Chats</h1>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setIsGroupModalOpen(true)}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
            aria-label="New group"
            title="New group"
          >
            <UsersIcon />
          </button>
          <button
            type="button"
            onClick={() => setIsModalOpen(true)}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
            aria-label="Start a new conversation"
            title="New chat"
          >
            <PlusIcon />
          </button>
        </div>
      </div>

      <div className="px-4 pb-3">
        <label className="relative block">
          <span className="sr-only">Search conversations</span>
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="search"
            placeholder="Search conversations"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="w-full rounded-lg border border-slate-200 bg-slate-50 py-2.5 pl-10 pr-3 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 dark:border-slate-700 dark:bg-surface-dark-subtle"
          />
        </label>
        {workspace && (
          <div className="mt-2 flex items-center gap-1" role="group" aria-label="Conversation filters">
            {LIST_FILTERS.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => setView(option.id)}
                aria-pressed={view === option.id}
                className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                  view === option.id ? "bg-brand-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300"
                }`}
              >
                {option.label}
              </button>
            ))}
            {productivityMode && <span className="ml-auto text-[10px] font-semibold uppercase tracking-wide text-brand-600">Productivity</span>}
          </div>
        )}
        {isShowingCached && <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">Offline — showing chats saved on this device.</p>}
        {(archivedCount > 0 || showArchived) && (
          <button
            type="button"
            onClick={() => setShowArchived((value) => !value)}
            aria-pressed={showArchived}
            className="mt-2 text-xs font-medium text-brand-600 hover:underline dark:text-brand-300"
          >
            {showArchived ? "← Back to chats" : `Archived (${archivedCount})`}
          </button>
        )}
      </div>

      <div className="flex flex-1 flex-col overflow-y-auto">
        {isLoading && <LoadingState label="Loading conversations…" />}

        {!isLoading && error && <ErrorState message={error} onRetry={() => void refresh()} />}

        {!isLoading && !error && showArchived && visible.length === 0 && (
          <EmptyState title="No archived chats" message="Chats you archive appear here." />
        )}

        {!isLoading && !error && !showArchived && visible.length === 0 && conversations.length === 0 && (
          <EmptyState
            icon={<ChatIcon width={28} height={28} />}
            title="No conversations yet"
            message="Start a new conversation to begin messaging. Only you and the people you chat with can see your messages."
          />
        )}

        {!isLoading && !error && !showArchived && visible.length === 0 && conversations.length > 0 && (
          <EmptyState title="No matches" message={filter ? `No conversations match "${filter}".` : "No conversations match this filter."} />
        )}

        {!isLoading &&
          !error &&
          sections.map((section) => (
            <div key={section.title ?? "all"}>
              {section.title && (
                <p className="px-4 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{section.title}</p>
              )}
              {section.items.map((conversation) => {
            const isActive = conversation.id === activeConversationId;
            const title = getConversationTitle(conversation);
            const preview = formatLastMessagePreview(conversation, conversation.lastMessage, user?.id);

            const muted = isMuted(conversation);

            return (
              <div
                key={conversation.id}
                className="group relative"
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenuFor(conversation.id);
                }}
              >
              <NavLink
                to={`/app/chat/${conversation.id}`}
                className={`flex items-center gap-3 px-4 py-3 transition-colors ${
                  isActive ? "bg-brand-50 dark:bg-brand-950" : "hover:bg-slate-100 dark:hover:bg-slate-800"
                }`}
              >
                <Avatar name={title} imageUrl={getConversationAvatarUrl(conversation)} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-slate-900 dark:text-slate-100">
                      {conversation.type === "group" && (
                        <UsersIcon width={14} height={14} className="shrink-0 text-slate-400" aria-label="Group" />
                      )}
                      <span className="truncate">{title}</span>
                    </p>
                    <span className="flex shrink-0 items-center gap-1 text-xs text-slate-400">
                      {conversation.pinned && <PinIcon width={12} height={12} aria-label="Pinned" />}
                      {muted && conversation.mutedUntil && (
                        <span title={describeMute(conversation.mutedUntil)}>
                          <BellIcon width={12} height={12} aria-label={describeMute(conversation.mutedUntil)} className="opacity-60" />
                        </span>
                      )}
                      {formatTimestamp(conversation.updatedAt)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm text-slate-500 dark:text-slate-400">{preview}</p>
                    {conversation.unreadCount > 0 && (
                      <span
                        className={`flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 text-xs font-semibold text-white ${
                          muted ? "bg-slate-400 dark:bg-slate-600" : "bg-brand-600"
                        }`}
                      >
                        {conversation.unreadCount > 99 ? "99+" : conversation.unreadCount}
                      </span>
                    )}
                  </div>
                </div>
                {/* Keeps the time/badge clear of the options button. */}
                <span className="w-6 shrink-0" aria-hidden />
              </NavLink>
              <div className="absolute right-2 top-1/2 -translate-y-1/2">
                <ChatRowMenu
                  conversation={conversation}
                  title={title}
                  open={menuFor === conversation.id}
                  onOpenChange={(open) => setMenuFor(open ? conversation.id : null)}
                  onChange={(changes) => updatePreferences(conversation.id, changes)}
                />
              </div>
              </div>
            );
              })}
            </div>
          ))}
      </div>

      {isModalOpen && <NewConversationModal onClose={() => setIsModalOpen(false)} />}
      {isGroupModalOpen && <NewGroupModal onClose={() => setIsGroupModalOpen(false)} />}
    </div>
  );
}
