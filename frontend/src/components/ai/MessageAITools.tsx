import { useEffect, useState } from "react";
import { useAI } from "../../context/AIContext";
import { useAuth } from "../../context/AuthContext";
import { aiService } from "../../services/aiService";
import type { SafetyFinding, ScamCheckResult, TranslationResult, VoiceResult, VoiceTranslationResult } from "../../types/ai";
import type { MessageDTO } from "../../types/message";
import { AIErrorNotice, AIGeneratedLabel, toAIError, type AIErrorInfo } from "./AIShared";

const RISK_LABELS = { likely_safe: "Likely safe", suspicious: "Suspicious", high_risk: "High risk" } as const;

/** The server's "no speech" result (see backend voice.service.ts): an empty transcript, not an error. */
const NO_SPEECH = "No speech was recognized in this voice message.";
/** Language hints the transcription API accepts (ISO 639 codes). */
const LANGUAGE_CODE = /^[a-z]{2,3}$/;

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
  /** "" = let the provider detect the language. */
  const [voiceLanguage, setVoiceLanguage] = useState("");
  const [copied, setCopied] = useState<"ok" | "failed" | null>(null);
  /** Your translations of the current transcript, by target language. */
  const [voiceTranslations, setVoiceTranslations] = useState<Record<string, VoiceTranslationResult>>({});
  /** "" = use the default target (see `voiceTarget` below). */
  const [voiceTargetChoice, setVoiceTargetChoice] = useState("");
  const [shownVoiceTranslation, setShownVoiceTranslation] = useState<string | null>(null);
  /** "" = use the default text target (see `textTarget` below). */
  const [textTargetChoice, setTextTargetChoice] = useState("");

  const isAudio = message.attachment?.kind === "audio";
  const attachmentId = message.attachment?.id;
  const voiceEnabled = !!ai.settings?.voiceEnabled;
  const transcript = voice?.transcript ?? null;

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

  // Translations belong to one transcript: a new transcript starts empty, then shows any stored ones (no provider call).
  useEffect(() => {
    setVoiceTranslations({});
    setShownVoiceTranslation(null);
    if (!accessToken || !attachmentId || !voiceEnabled || !transcript) return;
    let cancelled = false;
    aiService
      .listVoiceTranslations(accessToken, attachmentId)
      .then((stored) => {
        if (cancelled || stored.length === 0) return;
        setVoiceTranslations(Object.fromEntries(stored.map((t) => [t.targetLanguage, t])));
        const latest = stored.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a));
        setShownVoiceTranslation(latest.targetLanguage);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [accessToken, attachmentId, voiceEnabled, transcript]);

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

  // Text messages offer the same five targets as voice messages (Tamil, English, Hindi, Telugu, Malayalam).
  const textTargets = ai.server?.voiceTranslationLanguages ?? [];
  const textTargetName = (code: string) => textTargets.find((l) => l.code === code)?.name ?? code;
  // The source language is only known once a translation has come back; until then assume English.
  const textSource = translation?.detectedSourceLanguage ?? "en";
  const preferredLanguage = ai.settings?.preferredLanguage;
  // Default target: your preferred AI language if it's one of the five and differs from the source, else Tamil (English for Tamil text).
  const defaultTextTarget =
    preferredLanguage && preferredLanguage !== textSource && textTargets.some((l) => l.code === preferredLanguage)
      ? preferredLanguage
      : textSource === "ta"
        ? "en"
        : "ta";
  const textTarget = textTargetChoice || defaultTextTarget;
  // Same language in and out: the model returns the text unchanged, so say so instead of repeating it.
  const translationUnchanged =
    !!translation &&
    translation.translatedText.trim() === (message.body ?? "").trim() &&
    (!translation.detectedSourceLanguage || translation.detectedSourceLanguage === translation.targetLanguage);

  const translate = () =>
    run("translate", async () => {
      setTranslation(await aiService.translate(accessToken!, message.id, textTarget));
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

  const transcribe = () =>
    run("transcribe", async () => {
      setCopied(null);
      setVoice(await aiService.transcribe(accessToken!, attachmentId!, voiceLanguage || undefined));
    });

  async function copyTranscript() {
    if (!voice?.transcript) return;
    try {
      await navigator.clipboard.writeText(voice.transcript);
      setCopied("ok");
    } catch {
      setCopied("failed");
    }
  }
  const summarize = () => run("summarize", async () => setVoice(await aiService.analyzeVoice(accessToken!, attachmentId!)));

  const voiceTargets = ai.server?.voiceTranslationLanguages ?? [];
  const voiceTargetName = (code: string) => voiceTargets.find((l) => l.code === code)?.name ?? code;
  // Default target: your preferred AI language if it's one of the five and differs from what was spoken, else English (or Tamil for English speech).
  const preferred = ai.settings?.preferredLanguage;
  const spoken = voice?.detectedLanguage ?? null;
  const defaultVoiceTarget =
    preferred && preferred !== spoken && voiceTargets.some((l) => l.code === preferred) ? preferred : spoken === "en" ? "ta" : "en";
  const voiceTarget = voiceTargetChoice || defaultVoiceTarget;
  const canTranslateVoice =
    !!transcript && voice?.status !== "transcribing" && voiceEnabled && ai.canUseProvider && voiceTargets.length > 0;

  const translateVoice = () => {
    // Already translated into this language for this transcript: just show it.
    if (voiceTranslations[voiceTarget]) {
      setShownVoiceTranslation(voiceTarget);
      return;
    }
    void run("voice-translate", async () => {
      const result = await aiService.translateVoice(accessToken!, attachmentId!, voiceTarget);
      setVoiceTranslations((current) => ({ ...current, [result.targetLanguage]: result }));
      setShownVoiceTranslation(result.targetLanguage);
    });
  };
  const shownTranslation = shownVoiceTranslation ? voiceTranslations[shownVoiceTranslation] : undefined;

  const hasText = !!message.body;
  const actions: Array<{ id: string; label: string; onClick(): void }> = [];
  const canTranslateText = hasText && !isOwn && ai.canUseProvider;
  if (canTranslateText) actions.push({ id: "translate", label: "Translate", onClick: () => void translate() });
  if (hasText && !isOwn && ai.canUseProvider && ai.settings?.spamShieldEnabled) {
    actions.push({ id: "scam", label: "Check for scam", onClick: () => void checkScam() });
  }
  if (hasText && ai.settings?.aiMemoryEnabled) actions.push({ id: "remember", label: "Remember", onClick: () => void remember() });
  const canTranscribe = isAudio && voiceEnabled && !!ai.settings?.aiFeaturesEnabled && !!ai.server?.transcription.configured;
  // Opt-in stays explicit: say where to turn it on rather than offering an action that would send audio.
  const transcriptionOffHint = isAudio && !isOwn && !!ai.server?.transcription.configured && !canTranscribe;
  const languages = (ai.server?.supportedLanguages ?? []).filter((language) => LANGUAGE_CODE.test(language.code));
  const languageName = (code: string | null) => (code ? (languages.find((l) => l.code === code)?.name ?? code) : null);
  if (canTranscribe) {
    actions.push({ id: "transcribe", label: voice?.transcript ? "Transcribe again" : "Transcribe", onClick: () => void transcribe() });
    if (voice?.transcript && ai.server?.provider.configured) {
      actions.push({ id: "summarize", label: "Summarize", onClick: () => void summarize() });
    }
  }

  if (!finding && !translation && !scamResult && !voice && !error && !notice && actions.length === 0 && !transcriptionOffHint) return null;

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

      {translation && translationUnchanged && (
        <p className={`rounded-lg px-2 py-1.5 ${panel}`} role="status">
          This message is already in {textTargetName(translation.targetLanguage)}. Choose another language.
        </p>
      )}
      {translation && !translationUnchanged && !showOriginalOnly && (
        <div className={`rounded-lg px-2 py-1.5 ${panel}`} aria-label="Translation" lang={translation.targetLanguage}>
          <p className="whitespace-pre-wrap text-sm">{translation.translatedText}</p>
          <div className="mt-0.5 flex items-center justify-between gap-2">
            <span className={sub}>
              Translated to {textTargetName(translation.targetLanguage)}
              {translation.detectedSourceLanguage ? ` from ${translation.detectedSourceLanguage}` : ""}
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

      {busy === "transcribe" && (
        <p className={`rounded-lg px-2 py-1.5 ${panel} ${sub}`} role="status">
          Transcribing…
        </p>
      )}
      {voice && busy !== "transcribe" && (
        <div className={`rounded-lg px-2 py-1.5 ${panel}`} aria-label="Voice message transcript">
          {(voice.status === "transcribing" || voice.status === "processing") && <p className={sub}>Working on it…</p>}
          {voice.status === "failed" && voice.errorMessage && (
            <div className="flex flex-wrap items-baseline gap-x-2">
              <p>{voice.errorMessage === NO_SPEECH ? "No speech was recognized — try again, or pick the language it's in." : voice.errorMessage}</p>
              {canTranscribe && !voice.transcript && (
                <button type="button" onClick={() => void transcribe()} disabled={busy !== null} className="font-medium underline">
                  Try again
                </button>
              )}
            </div>
          )}
          {voice.transcript && (
            <>
              <div className="flex items-baseline justify-between gap-2">
                <p className="font-semibold">
                  Transcript
                  {voice.detectedLanguage && <span className={`ml-1 font-normal ${sub}`}>· {languageName(voice.detectedLanguage)}</span>}
                </p>
                <button type="button" onClick={() => void copyTranscript()} className="font-medium hover:underline" aria-label="Copy transcript">
                  {copied === "ok" ? "Copied" : "Copy"}
                </button>
              </div>
              <p className="whitespace-pre-wrap">{voice.transcript}</p>
              {copied === "failed" && <p className={sub}>Couldn't copy — select the text instead.</p>}
            </>
          )}
          {canTranslateVoice && (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5" role="group" aria-label="Translate voice message">
              <label className={`flex items-center gap-1 ${sub}`}>
                Translate to
                <select
                  aria-label="Translate to"
                  value={voiceTarget}
                  onChange={(e) => setVoiceTargetChoice(e.target.value)}
                  disabled={busy !== null}
                  className="rounded border-0 bg-transparent py-0 pl-0 pr-5 text-xs focus:ring-1"
                >
                  {voiceTargets.map((language) => (
                    <option key={language.code} value={language.code}>
                      {language.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                onClick={translateVoice}
                disabled={busy !== null}
                className="font-medium hover:underline disabled:opacity-50"
              >
                {busy === "voice-translate" ? "Translating…" : "Translate"}
              </button>
            </div>
          )}
          {busy === "voice-translate" && (
            <p className={sub} role="status">
              Translating to {voiceTargetName(voiceTarget)}…
            </p>
          )}
          {shownTranslation && busy !== "voice-translate" && (
            <div
              className={`mt-1.5 border-l-2 pl-2 ${isOwn ? "border-white/40" : "border-slate-300 dark:border-slate-600"}`}
              aria-label="Voice message translation"
            >
              <div className="flex items-baseline justify-between gap-2">
                <p className="font-semibold">
                  Translation
                  <span className={`ml-1 font-normal ${sub}`}>· {voiceTargetName(shownTranslation.targetLanguage)}</span>
                </p>
                <button type="button" className="font-medium hover:underline" onClick={() => setShownVoiceTranslation(null)}>
                  Hide
                </button>
              </div>
              <p className="whitespace-pre-wrap text-sm" lang={shownTranslation.targetLanguage}>
                {shownTranslation.translatedText}
              </p>
              <AIGeneratedLabel generatedBy={shownTranslation.generatedBy} cached={shownTranslation.cached} />
            </div>
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
      {transcriptionOffHint && !voice && (
        <p className={sub}>To transcribe voice messages, turn on Voice Intelligence in Settings → AI Features.</p>
      )}

      {error && <AIErrorNotice error={error} />}
      {notice && <p className={sub}>{notice}</p>}

      {actions.length > 0 && (
        <div className={`flex flex-wrap items-center gap-x-3 gap-y-0.5 ${sub}`} role="group" aria-label="AI actions">
          {canTranscribe && languages.length > 0 && (
            <label className="flex items-center gap-1">
              <span className="sr-only">Language of the voice message</span>
              <select
                value={voiceLanguage}
                onChange={(e) => setVoiceLanguage(e.target.value)}
                disabled={busy !== null}
                className="rounded border-0 bg-transparent py-0 pl-0 pr-5 text-xs focus:ring-1"
              >
                <option value="">Auto-detect language</option>
                {languages.map((language) => (
                  <option key={language.code} value={language.code}>
                    {language.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {canTranslateText && textTargets.length > 0 && (
            <select
              aria-label="Translate message to"
              value={textTarget}
              onChange={(e) => setTextTargetChoice(e.target.value)}
              disabled={busy !== null}
              className="rounded border-0 bg-transparent py-0 pl-0 pr-5 text-xs focus:ring-1"
            >
              {textTargets.map((language) => (
                <option key={language.code} value={language.code}>
                  {language.name}
                </option>
              ))}
            </select>
          )}
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
