import { useState, type FormEvent } from "react";
import { useAI } from "../../context/AIContext";
import { useAuth } from "../../context/AuthContext";
import { aiService } from "../../services/aiService";
import type { AskResult } from "../../types/ai";
import { Button } from "../ui/Button";
import { AIErrorNotice, AIGeneratedLabel, SourceList, toAIError, type AIErrorInfo } from "./AIShared";

const MAX_QUESTION = 500;

/** Ask Your Chats over the given conversations. The answer always comes with the real messages it relied on. */
export function AskPanel({ conversationIds, placeholder }: { conversationIds: string[]; placeholder?: string }) {
  const { accessToken } = useAuth();
  const ai = useAI();
  const [question, setQuestion] = useState("");
  const [useMemory, setUseMemory] = useState(true);
  const [result, setResult] = useState<AskResult | null>(null);
  const [error, setError] = useState<AIErrorInfo | null>(null);
  const [asking, setAsking] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!accessToken || !question.trim() || conversationIds.length === 0) return;
    setAsking(true);
    setError(null);
    setResult(null);
    try {
      setResult(await aiService.ask(accessToken, { question: question.trim(), conversationIds, useMemory }));
    } catch (err) {
      setError(toAIError(err));
    } finally {
      setAsking(false);
    }
  }

  return (
    <div className="space-y-3">
      <form onSubmit={(event) => void submit(event)} className="space-y-2">
        <textarea
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          maxLength={MAX_QUESTION}
          rows={3}
          placeholder={placeholder ?? "e.g. When did we agree to meet?"}
          className="w-full resize-none rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-surface-dark-subtle dark:text-slate-100"
          aria-label="Question about your chats"
        />
        <div className="flex items-center justify-between gap-2">
          {ai.settings?.aiMemoryEnabled ? (
            <label className="flex items-center gap-1.5 text-xs text-slate-500">
              <input type="checkbox" checked={useMemory} onChange={(event) => setUseMemory(event.target.checked)} />
              Use my AI memory
            </label>
          ) : (
            <span />
          )}
          <Button type="submit" isLoading={asking} disabled={!question.trim() || conversationIds.length === 0} className="py-1.5">
            Ask
          </Button>
        </div>
      </form>

      {asking && <p className="text-sm text-slate-400">Searching your messages…</p>}
      {error && <AIErrorNotice error={error} />}
      {result && (
        <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700" aria-live="polite">
          {result.status === "insufficient_information" && (
            <p className="mb-1 text-xs font-semibold uppercase text-amber-600">Not enough information</p>
          )}
          <p className="whitespace-pre-wrap text-sm text-slate-800 dark:text-slate-100">{result.answer}</p>
          <SourceList sources={result.sources} />
          <div className="mt-2">
            {result.generatedBy ? (
              <AIGeneratedLabel generatedBy={result.generatedBy} />
            ) : (
              <p className="text-[11px] text-slate-400">No AI call was needed.</p>
            )}
            {result.contextMessageCount > 0 && (
              <p className="text-[11px] text-slate-400">
                Based on {result.contextMessageCount} message{result.contextMessageCount === 1 ? "" : "s"}
                {result.usedMemory ? " and your AI memory" : ""}.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
