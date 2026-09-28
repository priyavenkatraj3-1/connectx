import { useState } from "react";
import { useAI } from "../../context/AIContext";
import { CloseIcon } from "../ui/icons";
import { ActionsPanel } from "./ActionsPanel";
import { AIErrorNotice } from "./AIShared";
import { AskPanel } from "./AskPanel";
import { DecisionPanel } from "./DecisionPanel";

type Tab = "ask" | "actions" | "decisions";

interface ConversationAIPanelProps {
  conversationId: string;
  isGroup: boolean;
  onClose(): void;
}

/** Side panel with the AI features that work on one conversation. Shown only when the user opens it. */
export function ConversationAIPanel({ conversationId, isGroup, onClose }: ConversationAIPanelProps) {
  const ai = useAI();
  const [tab, setTab] = useState<Tab>("ask");
  const [toggling, setToggling] = useState(false);
  const excluded = ai.exclusions.includes(conversationId);

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "ask", label: "Ask" },
    { id: "actions", label: "Actions" },
    ...(isGroup ? [{ id: "decisions" as const, label: "Decisions" }] : []),
  ];

  async function toggleExclusion() {
    setToggling(true);
    try {
      await ai.setExcluded(conversationId, !excluded);
    } catch {
      // The switch simply doesn't change; the settings page shows the authoritative list.
    } finally {
      setToggling(false);
    }
  }

  let blocker: { message: string; code: string } | null = null;
  if (ai.settings && ai.server) {
    if (!ai.settings.aiFeaturesEnabled) {
      blocker = { message: "AI features are off. Turn them on in Settings → AI Features.", code: "ai_disabled" };
    } else if (!ai.server.provider.configured) {
      blocker = { message: "AI features aren't configured on this server yet.", code: "ai_not_configured" };
    } else if (!ai.settings.chatRetrievalEnabled) {
      blocker = { message: "Allow AI to read your chats in Settings → AI Features to use this.", code: "ai_disabled" };
    } else if (excluded) {
      blocker = { message: "This chat is excluded from AI.", code: "ai_excluded_here" };
    }
  }

  return (
    <aside
      className="flex w-full flex-col border-l border-slate-200 bg-white dark:border-slate-800 dark:bg-surface-dark md:w-96"
      aria-label="AI assistant"
    >
      <header className="flex items-center gap-2 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <h2 className="flex-1 text-sm font-semibold text-slate-900 dark:text-slate-100">
          AI assistant
          {ai.activeRequests > 0 && <span className="ml-2 text-xs font-normal text-slate-400">working…</span>}
        </h2>
        <button
          type="button"
          onClick={onClose}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
          aria-label="Close AI assistant"
        >
          <CloseIcon width={18} height={18} />
        </button>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {blocker ? (
          <AIErrorNotice error={blocker} />
        ) : (
          <>
            <div className="flex gap-1 border-b border-slate-100 dark:border-slate-800" role="tablist">
              {tabs.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === option.id}
                  onClick={() => setTab(option.id)}
                  className={`px-3 py-1.5 text-sm font-medium ${
                    tab === option.id ? "border-b-2 border-brand-600 text-brand-700 dark:text-brand-300" : "text-slate-500"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
            {tab === "ask" && <AskPanel conversationIds={[conversationId]} placeholder="Ask something about this chat" />}
            {tab === "actions" && <ActionsPanel conversationId={conversationId} />}
            {tab === "decisions" && isGroup && <DecisionPanel conversationId={conversationId} />}
          </>
        )}

        <label className="flex items-center justify-between gap-3 border-t border-slate-100 pt-4 text-sm dark:border-slate-800">
          <span>
            <span className="block font-medium text-slate-800 dark:text-slate-100">Exclude this chat from AI</span>
            <span className="block text-xs text-slate-500">Your AI features won't read or translate it.</span>
          </span>
          <input
            type="checkbox"
            role="switch"
            checked={excluded}
            disabled={toggling}
            onChange={() => void toggleExclusion()}
            aria-label="Exclude this chat from AI"
          />
        </label>
      </div>
    </aside>
  );
}
