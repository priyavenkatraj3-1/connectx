import { useMemo, useState } from "react";
import { AIErrorNotice } from "../../components/ai/AIShared";
import { AskPanel } from "../../components/ai/AskPanel";
import { LoadingState } from "../../components/common/LoadingState";
import { Avatar } from "../../components/ui/Avatar";
import { useAI } from "../../context/AIContext";
import { useConversations } from "../../context/ConversationsContext";
import { getConversationAvatarUrl, getConversationTitle } from "../../utils/conversationDisplay";

/** Must match the server's AI_LIMITS.maxConversationsPerQuestion. */
const MAX_SELECTED = 10;

/** Ask Your Chats across several conversations the user picks. */
export function AskYourChatsView() {
  const ai = useAI();
  const { conversations, isLoading } = useConversations();
  const [selected, setSelected] = useState<string[]>([]);
  const [filter, setFilter] = useState("");

  const available = useMemo(
    () =>
      conversations
        .filter((c) => !ai.exclusions.includes(c.id))
        .filter((c) => getConversationTitle(c).toLowerCase().includes(filter.trim().toLowerCase())),
    [conversations, ai.exclusions, filter]
  );

  function toggle(id: string) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : prev.length >= MAX_SELECTED ? prev : [...prev, id]));
  }

  let blocker: { message: string; code: string } | null = null;
  if (ai.settings && ai.server) {
    if (!ai.settings.aiFeaturesEnabled) {
      blocker = { message: "AI features are off. Turn them on in Settings → AI Features to ask your chats.", code: "ai_disabled" };
    } else if (!ai.server.provider.configured) {
      blocker = { message: "AI features aren't configured on this server yet.", code: "ai_not_configured" };
    } else if (!ai.settings.chatRetrievalEnabled) {
      blocker = { message: "Allow AI to read your chats in Settings → AI Features to use this.", code: "ai_disabled" };
    }
  }

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl p-6">
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Ask Your Chats</h1>
        <p className="mb-6 text-sm text-slate-500 dark:text-slate-400">
          Pick up to {MAX_SELECTED} chats and ask a question. Answers only use messages you can already see, and show
          the messages they're based on.
        </p>

        {ai.isLoading && !ai.settings ? (
          <LoadingState label="Loading…" />
        ) : blocker ? (
          <AIErrorNotice error={blocker} />
        ) : (
          <div className="space-y-6">
            <section aria-label="Chats to search">
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Chats ({selected.length}/{MAX_SELECTED})
                </h2>
                {selected.length > 0 && (
                  <button type="button" onClick={() => setSelected([])} className="text-xs text-slate-500 hover:underline">
                    Clear
                  </button>
                )}
              </div>
              <input
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter chats"
                className="mb-2 w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm dark:border-slate-700 dark:bg-surface-dark-subtle dark:text-slate-100"
                aria-label="Filter chats"
              />
              {isLoading ? (
                <p className="text-sm text-slate-400">Loading chats…</p>
              ) : (
                <ul className="max-h-64 space-y-1 overflow-y-auto">
                  {available.map((conversation) => {
                    const title = getConversationTitle(conversation);
                    const checked = selected.includes(conversation.id);
                    return (
                      <li key={conversation.id}>
                        <label className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-800">
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={!checked && selected.length >= MAX_SELECTED}
                            onChange={() => toggle(conversation.id)}
                          />
                          <Avatar name={title} imageUrl={getConversationAvatarUrl(conversation)} size="sm" />
                          <span className="truncate text-sm text-slate-800 dark:text-slate-100">{title}</span>
                        </label>
                      </li>
                    );
                  })}
                  {available.length === 0 && <li className="text-sm text-slate-400">No chats to show.</li>}
                </ul>
              )}
            </section>
            <AskPanel conversationIds={selected} placeholder="e.g. What did Priya say about the launch date?" />
          </div>
        )}
      </div>
    </div>
  );
}
