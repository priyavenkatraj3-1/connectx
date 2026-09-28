import { useState } from "react";
import { useAuth } from "../../context/AuthContext";
import { aiService } from "../../services/aiService";
import type { DecisionMode, DecisionPoint, DecisionSummary } from "../../types/ai";
import { Button } from "../ui/Button";
import { AIErrorNotice, AIGeneratedLabel, SourceList, toAIError, type AIErrorInfo } from "./AIShared";

const MODES: Array<{ value: DecisionMode; label: string }> = [
  { value: "summary", label: "Summary" },
  { value: "decisions", label: "Decisions" },
  { value: "open_issues", label: "Open issues" },
];

function Section({ title, items }: { title: string; items: DecisionPoint[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <h4 className="mt-3 text-xs font-semibold uppercase text-slate-500">{title}</h4>
      <ul className="mt-1 space-y-2">
        {items.map((item, index) => (
          <li key={index} className="text-sm text-slate-800 dark:text-slate-100">
            {item.text}
            <details className="text-xs">
              <summary className="cursor-pointer text-slate-400">
                {item.sources.length} source{item.sources.length === 1 ? "" : "s"}
              </summary>
              <SourceList sources={item.sources} />
            </details>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Group Decision AI: every listed item links back to the messages that support it; unsupported items are dropped server-side. */
export function DecisionPanel({ conversationId }: { conversationId: string }) {
  const { accessToken } = useAuth();
  const [mode, setMode] = useState<DecisionMode>("summary");
  const [result, setResult] = useState<DecisionSummary | null>(null);
  const [error, setError] = useState<AIErrorInfo | null>(null);
  const [running, setRunning] = useState(false);

  async function run() {
    if (!accessToken) return;
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      setResult(await aiService.decisionSummary(accessToken, conversationId, mode));
    } catch (err) {
      setError(toAIError(err));
    } finally {
      setRunning(false);
    }
  }

  const isEmpty =
    result &&
    result.hasContent &&
    [result.proposals, result.agreements, result.disagreements, result.openQuestions, result.decisions, result.actionItems].every(
      (list) => list.length === 0
    );

  return (
    <div className="space-y-3">
      <div className="flex gap-1" role="radiogroup" aria-label="Analysis type">
        {MODES.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={mode === option.value}
            onClick={() => setMode(option.value)}
            className={`flex-1 rounded-md px-2 py-1 text-xs font-medium ${
              mode === option.value ? "bg-brand-600 text-white" : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
      <Button onClick={() => void run()} isLoading={running} variant="secondary" className="w-full py-1.5">
        Analyze group discussion
      </Button>
      {error && <AIErrorNotice error={error} />}
      {result && (
        <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700" aria-live="polite">
          <p className="whitespace-pre-wrap text-sm text-slate-800 dark:text-slate-100">{result.summary}</p>
          <Section title="Decisions" items={result.decisions} />
          <Section title="Agreements" items={result.agreements} />
          <Section title="Disagreements" items={result.disagreements} />
          <Section title="Proposals" items={result.proposals} />
          <Section title="Open questions" items={result.openQuestions} />
          <Section title="Action items" items={result.actionItems} />
          {isEmpty && <p className="mt-2 text-sm text-slate-400">No decisions or open points were clearly supported by the messages.</p>}
          {result.droppedUnsupportedItems > 0 && (
            <p className="mt-2 text-[11px] text-slate-400">
              {result.droppedUnsupportedItems} item{result.droppedUnsupportedItems === 1 ? " was" : "s were"} left out because no
              message supported {result.droppedUnsupportedItems === 1 ? "it" : "them"}.
            </p>
          )}
          {result.hasContent && (
            <div className="mt-2">
              <AIGeneratedLabel generatedBy={result.generatedBy} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
