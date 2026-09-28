import { useEffect, useState } from "react";
import { useAI } from "../../context/AIContext";
import { useAuth } from "../../context/AuthContext";
import { aiService } from "../../services/aiService";
import type { SafetyFinding, ScamCheckResult, TranslationResult, VoiceResult } from "../../types/ai";
import type { MessageDTO } from "../../types/message";
import { AIErrorNotice, AIGeneratedLabel, toAIError, type AIErrorInfo } from "./AIShared";

const RISK_LABELS = { likely_safe: "Likely safe", suspicious: "Suspicious", high_risk: "High risk" } as const;

interface MessageAIToolsProps {
  message: MessageDTO;
  isOwn: boolean;
  /** Local Scam Shield finding for this message, if any. */
  finding?: SafetyFinding;
  onFindingHandled?(messageId: string): void;
}

/**
 * Per-message AI actions (translate, scam check, remember, voice) and their
 * results, rendered inside the message bubble. Everything runs only when the
 * user clicks; nothing is sent to an AI provider on render.
 */
export function MessageAITools({ message, isOwn, finding, onFindingHandled }: MessageAIToolsProps) {
  const { accessToken } = useAuth();
  const ai = useAI();
  const [translation, setTranslation] = useState<TranslationResult | null>(null);
  const [showOriginalOnly, setShowOriginalOnly] = useState(false);
  const [scamResult, setScamResult] = useState<ScamCheckResult | null>(null);
  const [voice, setVoice] = useState<VoiceResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<AIErrorInfo | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const isAudio = message.attachment?.kind === "audio";
  const attachmentId = message.attachment?.id;
  const voiceEnabled = !!ai.settings?.voiceEnabled;

  // Show a voice result the user already created (on any device). Reading it sends nothing to a provider.
  useEffect(() => {
    if (!accessToken || !isAudio || !attachmentId || !voiceEnabled) return;
    let cancelled = false;
    aiService
      .getVoice(accessToken, attachmentId)
      .then((result) => {
        if (!cancelled) setVoice(result);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [accessToken, isAudio, attachmentId, voiceEnabled]);

  async function run(label: string, operation: () => Promise<void>) {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      await operation();
    } catch (err) {
      setError(toAIError(err));
    } finally {
      setBusy(null);
    }
  }

  const translate = () =>
    run("translate", async () => {
      setTranslation(await aiService.translate(accessToken!, message.id, ai.settings?.preferredLanguage ?? "en"));
      setShowOriginalOnly(false);
    });

  const checkScam = () => run("scam", async () => setScamResult(await aiService.scamCheck(accessToken!, message.id)));

  const remember = () =>
    run("remember", async () => {
      await aiService.createMemory(accessToken!, { type: "fact", content: message.body!.slice(0, 500), sourceMessageId: message.id });
      setNotice("Saved to your AI memory.");
    });

  const feedback = (action: "dismissed" | "reported") =>
    run("feedback", async () => {
      await aiService.safetyFeedback(accessToken!, message.id, action);
      onFindingHandled?.(message.id);
      if (action === "reported") setNotice("Thanks — this message was reported for review.");
    });

  const transcribe = () => run("transcribe", async () => setVoice(await aiService.transcribe(accessToken!, attachmentId!)));
  const summarize = () => run("summarize", async () => setVoice(await aiService.analyzeVoice(accessToken!, attachmentId!)));

  const hasText = !!message.body;
  const actions: Array<{ id: string; label: string; onClick(): void }> = [];
  if (hasText && !isOwn && ai.canUseProvider) actions.push({ id: "translate", label: "Translate", onClick: () => void translate() });
  if (hasText && !isOwn && ai.canUseProvider && ai.settings?.spamShieldEnabled) {
    actions.push({ id: "scam", label: "Check for scam", onClick: () => void checkScam() });
  }
  if (hasText && ai.settings?.aiMemoryEnabled) actions.push({ id: "remember", label: "Remember", onClick: () => void remember() });
  if (isAudio && voiceEnabled && ai.settings?.aiFeaturesEnabled && ai.server?.transcription.configured) {
    actions.push({ id: "transcribe", label: voice?.transcript ? "Transcribe again" : "Transcribe", onClick: () => void transcribe() });
    if (voice?.transcript && ai.server?.provider.configured) {
      actions.push({ id: "summarize", label: "Summarize", onClick: () => void summarize() });
    }
  }

  if (!finding && !translation && !scamResult && !voice && !error && !notice && actions.length === 0) return null;

  const sub = isOwn ? "text-white/80" : "text-slate-500 dark:text-slate-400";
  const panel = isOwn ? "bg-white/10" : "bg-slate-50 dark:bg-slate-800/70";

  return (
    <div className="mt-1 space-y-1.5 text-xs" data-testid="message-ai-tools">
      {finding && (
        <div
          role="alert"
          className={`rounded-lg border px-2 py-1.5 ${
            finding.riskLevel === "high_risk"
              ? "border-red-300 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-100"
              : "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100"
          }`}
        >
          <p className="font-semibold">⚠ {RISK_LABELS[finding.riskLevel]}: this message shows common scam signs</p>
          <ul className="mt-0.5 list-disc pl-4">
            {finding.signals.map((signal) => (
              <li key={signal.type}>{signal.description}</li>
            ))}
            {finding.links.flatMap((link) => link.reasons.map((reason) => <li key={`${link.url}-${reason}`}>{reason}</li>))}
          </ul>
          <p className="mt-1 opacity-80">Automated warning — it can be wrong. Never share passwords or codes.</p>
          <div className="mt-1 flex gap-3 font-medium">
            <button type="button" onClick={() => void feedback("dismissed")} disabled={busy !== null}>
              Dismiss
            </button>
            <button type="button" onClick={() => void feedback("reported")} disabled={busy !== null}>
              Report
            </button>
          </div>
        </div>
      )}

      {translation && !showOriginalOnly && (
        <div className={`rounded-lg px-2 py-1.5 ${panel}`} aria-label="Translation">
          <p className="whitespace-pre-wrap text-sm">{translation.translatedText}</p>
          <div className="mt-0.5 flex items-center justify-between gap-2">
            <span className={sub}>
              Translated{translation.detectedSourceLanguage ? ` from ${translation.detectedSourceLanguage}` : ""}
            </span>
            <button type="button" className="font-medium underline" onClick={() => setShowOriginalOnly(true)}>
              Hide
            </button>
          </div>
          <AIGeneratedLabel generatedBy={translation.generatedBy} cached={translation.cached} />
        </div>
      )}

      {scamResult && (
        <div className={`rounded-lg px-2 py-1.5 ${panel}`} aria-label="Scam check result">
          <p className="font-semibold">{RISK_LABELS[scamResult.riskLevel]}</p>
          {scamResult.ai && scamResult.ai.reasons.length > 0 && (
            <ul className="list-disc pl-4">
              {scamResult.ai.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
          <p className={`mt-0.5 ${sub}`}>{scamResult.disclaimer}</p>
          <AIGeneratedLabel generatedBy={scamResult.generatedBy} />
        </div>
      )}

      {voice && (
        <div className={`rounded-lg px-2 py-1.5 ${panel}`} aria-label="Voice message transcript">
          {(voice.status === "transcribing" || voice.status === "processing") && <p className={sub}>Working on it…</p>}
          {voice.status === "failed" && voice.errorMessage && <p>{voice.errorMessage}</p>}
          {voice.transcript && (
            <>
              <p className="font-semibold">Transcript</p>
              <p className="whitespace-pre-wrap">{voice.transcript}</p>
            </>
          )}
          {voice.summary && (
            <>
              <p className="mt-1 font-semibold">Summary</p>
              <p>{voice.summary}</p>
            </>
          )}
          {voice.actionItems.length > 0 && (
            <ul className="list-disc pl-4">
              {voice.actionItems.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
          <p className={sub}>AI-generated · may contain transcription errors</p>
        </div>
      )}

      {error && <AIErrorNotice error={error} />}
      {notice && <p className={sub}>{notice}</p>}

      {actions.length > 0 && (
        <div className={`flex flex-wrap gap-x-3 gap-y-0.5 ${sub}`} role="group" aria-label="AI actions">
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              onClick={action.onClick}
              disabled={busy !== null}
              className="font-medium hover:underline disabled:opacity-50"
            >
              {busy === action.id ? `${action.label}…` : action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
