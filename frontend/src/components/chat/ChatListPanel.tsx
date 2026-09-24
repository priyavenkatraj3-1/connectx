import { EmptyState } from "../common/EmptyState";
import { ChatIcon, PlusIcon, SearchIcon } from "../ui/icons";

export function ChatListPanel() {
  return (
    <div className="flex w-full flex-col border-r border-slate-200 dark:border-slate-800 md:w-96">
      <div className="flex items-center justify-between px-4 py-4">
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Chats</h1>
        <button
          type="button"
          className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
          aria-label="Start a new conversation"
          title="Coming soon"
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
            className="w-full rounded-lg border border-slate-200 bg-slate-50 py-2.5 pl-10 pr-3 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 dark:border-slate-700 dark:bg-surface-dark-subtle"
          />
        </label>
      </div>

      <div className="flex flex-1 overflow-y-auto">
        <EmptyState
          icon={<ChatIcon width={28} height={28} />}
          title="No conversations yet"
          message="When you start a chat, it will show up here. Conversation history is only visible to you and the people you're chatting with."
        />
      </div>
    </div>
  );
}
