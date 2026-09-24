import { useState } from "react";
import { NavLink, useParams } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { useConversations } from "../../context/ConversationsContext";
import { EmptyState } from "../common/EmptyState";
import { ErrorState } from "../common/ErrorState";
import { LoadingState } from "../common/LoadingState";
import { Avatar } from "../ui/Avatar";
import { ChatIcon, PlusIcon, SearchIcon } from "../ui/icons";
import { NewConversationModal } from "./NewConversationModal";
import { formatTimestamp } from "../../utils/formatTime";

export function ChatListPanel() {
  const { user } = useAuth();
  const { conversations, isLoading, error, refresh } = useConversations();
  const { conversationId: activeConversationId } = useParams();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [filter, setFilter] = useState("");

  const visible = conversations.filter((c) =>
    c.otherParticipant.displayName.toLowerCase().includes(filter.trim().toLowerCase())
  );

  return (
    <div
      className={`w-full flex-col border-r border-slate-200 dark:border-slate-800 md:flex md:w-96 ${
        activeConversationId ? "hidden" : "flex"
      }`}
    >
      <div className="flex items-center justify-between px-4 py-4">
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Chats</h1>
        <button
          type="button"
          onClick={() => setIsModalOpen(true)}
          className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
          aria-label="Start a new conversation"
        >
          <PlusIcon />
        </button>
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
      </div>

      <div className="flex flex-1 flex-col overflow-y-auto">
        {isLoading && <LoadingState label="Loading conversations…" />}

        {!isLoading && error && <ErrorState message={error} onRetry={() => void refresh()} />}

        {!isLoading && !error && visible.length === 0 && conversations.length === 0 && (
          <EmptyState
            icon={<ChatIcon width={28} height={28} />}
            title="No conversations yet"
            message="Start a new conversation to begin messaging. Only you and the people you chat with can see your messages."
          />
        )}

        {!isLoading && !error && visible.length === 0 && conversations.length > 0 && (
          <EmptyState title="No matches" message={`No conversations match "${filter}".`} />
        )}

        {!isLoading &&
          !error &&
          visible.map((conversation) => {
            const isActive = conversation.id === activeConversationId;
            const isOwnLastMessage = conversation.lastMessage?.senderId === user?.id;
            const preview = conversation.lastMessage
              ? `${isOwnLastMessage ? "You: " : ""}${conversation.lastMessage.body ?? ""}`
              : "No messages yet";

            return (
              <NavLink
                key={conversation.id}
                to={`/app/chat/${conversation.id}`}
                className={`flex items-center gap-3 px-4 py-3 transition-colors ${
                  isActive ? "bg-brand-50 dark:bg-brand-950" : "hover:bg-slate-100 dark:hover:bg-slate-800"
                }`}
              >
                <Avatar
                  name={conversation.otherParticipant.displayName}
                  imageUrl={conversation.otherParticipant.avatarUrl ?? undefined}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                      {conversation.otherParticipant.displayName}
                    </p>
                    <span className="shrink-0 text-xs text-slate-400">{formatTimestamp(conversation.updatedAt)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm text-slate-500 dark:text-slate-400">{preview}</p>
                    {conversation.unreadCount > 0 && (
                      <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-brand-600 px-1.5 text-xs font-semibold text-white">
                        {conversation.unreadCount > 99 ? "99+" : conversation.unreadCount}
                      </span>
                    )}
                  </div>
                </div>
              </NavLink>
            );
          })}
      </div>

      {isModalOpen && <NewConversationModal onClose={() => setIsModalOpen(false)} />}
    </div>
  );
}
