import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useAI } from "../../context/AIContext";
import { useAuth } from "../../context/AuthContext";
import { useConversations } from "../../context/ConversationsContext";
import { aiService, type AISettingsUpdate } from "../../services/aiService";
import type { AIMemory, MemoryType } from "../../types/ai";
import { getConversationTitle } from "../../utils/conversationDisplay";
import { LoadingState } from "../common/LoadingState";
import { Button } from "../ui/Button";
import { AIErrorNotice, toAIError, Toggle, type AIErrorInfo } from "./AIShared";

const MEMORY_TYPES: Array<{ value: MemoryType; label: string }> = [
  { value: "preference", label: "Preference" },
  { value: "fact", label: "Fact" },
  { value: "context", label: "Context" },
  { value: "working", label: "Working note" },
];

/** Settings → AI Features: consent switches, provider status, disclosure, memory and exclusions. */
export function AISettingsPanel() {
  const ai = useAI();
  const [error, setError] = useState<AIErrorInfo | null>(null);
  const [saving, setSaving] = useState(false);

  if (ai.isLoading && !ai.settings) return <LoadingState label="Loading AI settings…" />;
  if (!ai.settings || !ai.server) {
    return <AIErrorNotice error={{ message: ai.loadError ?? "Couldn't load AI settings", code: undefined }} />;
  }
  const { settings, server } = ai;

  async function save(update: AISettingsUpdate) {
    setSaving(true);
    setError(null);
    try {
      await ai.updateSettings(update);
    } catch (err) {
      setError(toAIError(err));
    } finally {
      setSaving(false);
    }
  }

  const masterOff = !settings.aiFeaturesEnabled;

  return (
    <div className="space-y-8">
      <section>
        {!server.provider.configured && (
          <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-200">
            AI features aren't configured on this server yet. You can set your preferences now; features that need an AI
            provider will stay unavailable until an administrator configures one. Scam/Spam Shield warnings work without it.
          </div>
        )}
        {server.provider.configured && (
          <p className="mb-4 text-xs text-slate-500 dark:text-slate-400">
            AI provider: {server.provider.name}
            {server.provider.model ? ` (${server.provider.model})` : ""} · Voice transcription:{" "}
            {server.transcription.configured ? server.transcription.name : "not configured"}
          </p>
        )}
        {error && (
          <div className="mb-4">
            <AIErrorNotice error={error} />
          </div>
        )}

        <Toggle
          label="AI features"
          description="Master switch. While it's off, nothing is sent to an AI provider."
          checked={settings.aiFeaturesEnabled}
          disabled={saving}
          onChange={(value) => void save({ aiFeaturesEnabled: value })}
        />
        <Toggle
          label="Let AI read my chats"
          description="Needed for Ask Your Chats, Group Decision AI and Smart Actions. Only chats you pick are read."
          checked={settings.chatRetrievalEnabled}
          disabled={saving || masterOff}
          onChange={(value) => void save({ chatRetrievalEnabled: value })}
        />
        <Toggle
          label="AI Memory"
          description="Save notes you choose (never automatically) and use them to interpret your questions."
          checked={settings.aiMemoryEnabled}
          disabled={saving}
          onChange={(value) => void save({ aiMemoryEnabled: value })}
        />
        <Toggle
          label="Scam/Spam Shield"
          description="Warn about suspicious messages. Automatic checks run on ConnectX's server; an AI check only runs when you ask."
          checked={settings.spamShieldEnabled}
          disabled={saving}
          onChange={(value) => void save({ spamShieldEnabled: value })}
        />
        <Toggle
          label="Voice Intelligence"
          description="Transcribe and summarize voice messages you choose."
          checked={settings.voiceEnabled}
          disabled={saving || masterOff}
          onChange={(value) => void save({ voiceEnabled: value })}
        />
        <label className="flex items-center justify-between gap-4 py-4">
          <span>
            <span className="block text-sm font-medium text-slate-900 dark:text-slate-100">Translation language</span>
            <span className="block text-sm text-slate-500 dark:text-slate-400">Messages are translated into this language.</span>
          </span>
          <select
            className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-surface-dark-subtle dark:text-slate-100"
            value={settings.preferredLanguage}
            disabled={saving}
            onChange={(event) => void save({ preferredLanguage: event.target.value })}
            aria-label="Translation language"
          >
            {server.supportedLanguages.map((language) => (
              <option key={language.code} value={language.code}>
                {language.name}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold text-slate-900 dark:text-slate-100">What is shared</h3>
        <ul className="list-disc space-y-1 pl-5 text-sm text-slate-500 dark:text-slate-400">
          {server.dataSharing.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </section>

      <MemoryManager />
      <ExcludedChats />
    </div>
  );
}

function MemoryManager() {
  const { accessToken } = useAuth();
  const ai = useAI();
  const [items, setItems] = useState<AIMemory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AIErrorInfo | null>(null);
  const [type, setType] = useState<MemoryType>("preference");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!accessToken) return;
    try {
      setItems((await aiService.listMemories(accessToken)).items);
    } catch (err) {
      setError(toAIError(err));
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    void load();
  }, [load]);

  async function add(event: FormEvent) {
    event.preventDefault();
    if (!accessToken || !content.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const memory = await aiService.createMemory(accessToken, { type, content: content.trim() });
      setItems((prev) => [memory, ...prev]);
      setContent("");
    } catch (err) {
      setError(toAIError(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(memoryId: string) {
    if (!accessToken) return;
    setError(null);
    try {
      await aiService.deleteMemory(accessToken, memoryId);
      setItems((prev) => prev.filter((item) => item.id !== memoryId));
    } catch (err) {
      setError(toAIError(err));
    }
  }

  async function clearAll() {
    if (!accessToken || !window.confirm("Delete all saved AI memories? This can't be undone.")) return;
    setError(null);
    try {
      await aiService.clearMemories(accessToken);
      setItems([]);
    } catch (err) {
      setError(toAIError(err));
    }
  }

  return (
    <section aria-label="AI memory">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">AI memory</h3>
        {items.length > 0 && (
          <button type="button" onClick={() => void clearAll()} className="text-xs font-medium text-red-600 hover:underline">
            Clear all
          </button>
        )}
      </div>
      <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">
        Only notes you add here (or save from a message) are remembered. You can always view and delete them, even with
        memory turned off.
      </p>
      {error && (
        <div className="mb-3">
          <AIErrorNotice error={error} />
        </div>
      )}
      {ai.settings?.aiMemoryEnabled && (
        <form onSubmit={(event) => void add(event)} className="mb-3 flex gap-2">
          <select
            value={type}
            onChange={(event) => setType(event.target.value as MemoryType)}
            className="rounded-lg border border-slate-200 bg-white px-2 text-sm dark:border-slate-700 dark:bg-surface-dark-subtle dark:text-slate-100"
            aria-label="Memory type"
          >
            {MEMORY_TYPES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <input
            value={content}
            onChange={(event) => setContent(event.target.value)}
            maxLength={500}
            placeholder="e.g. I prefer meetings after 10am"
            className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm dark:border-slate-700 dark:bg-surface-dark-subtle dark:text-slate-100"
            aria-label="New memory"
          />
          <Button type="submit" isLoading={busy} disabled={!content.trim()} className="py-1.5">
            Save
          </Button>
        </form>
      )}
      {loading ? (
        <p className="text-sm text-slate-400">Loading…</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-slate-400">No memories saved.</p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((item) => (
            <li key={item.id} className="flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm dark:bg-slate-800/60">
              <span className="shrink-0 rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-slate-600 dark:bg-slate-700 dark:text-slate-300">
                {item.type}
              </span>
              <span className="flex-1 text-slate-700 dark:text-slate-200">{item.content}</span>
              <button
                type="button"
                onClick={() => void remove(item.id)}
                className="text-xs text-slate-400 hover:text-red-600"
                aria-label={`Delete memory: ${item.content}`}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ExcludedChats() {
  const ai = useAI();
  const { getConversation } = useConversations();
  if (ai.exclusions.length === 0) return null;
  return (
    <section aria-label="Chats excluded from AI">
      <h3 className="mb-2 text-sm font-semibold text-slate-900 dark:text-slate-100">Chats excluded from AI</h3>
      <ul className="space-y-1.5">
        {ai.exclusions.map((conversationId) => {
          const conversation = getConversation(conversationId);
          return (
            <li key={conversationId} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-sm dark:bg-slate-800/60">
              <span className="text-slate-700 dark:text-slate-200">
                {conversation ? getConversationTitle(conversation) : "A chat you've left"}
              </span>
              <button
                type="button"
                onClick={() => void ai.setExcluded(conversationId, false).catch(() => undefined)}
                className="text-xs font-medium text-brand-600 hover:underline"
              >
                Include again
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
