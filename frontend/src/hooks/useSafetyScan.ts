import { useCallback, useEffect, useMemo, useState } from "react";
import { useOptionalAI } from "../context/AIContext";
import { useAuth } from "../context/AuthContext";
import { aiService } from "../services/aiService";
import type { SafetyFinding } from "../types/ai";
import type { MessageDTO } from "../types/message";

/** The server accepts at most this many message ids per scan. */
const MAX_SCAN = 100;

/**
 * Scam/Spam Shield warnings for the loaded messages of a conversation.
 * Uses the server's local heuristics only (no AI provider), and only when
 * the user turned the shield on. Own messages are skipped by the server.
 */
export function useSafetyScan(conversationId: string | undefined, messages: MessageDTO[], currentUserId: string | undefined) {
  const ai = useOptionalAI();
  const { accessToken } = useAuth();
  const [findings, setFindings] = useState<Map<string, SafetyFinding>>(new Map());
  const enabled = !!ai?.settings?.spamShieldEnabled;

  // Stable key of the text messages from others that are worth scanning.
  const idsKey = useMemo(
    () =>
      messages
        .filter((m) => m.body && m.senderId !== currentUserId)
        .slice(-MAX_SCAN)
        .map((m) => m.id)
        .join(","),
    [messages, currentUserId]
  );

  useEffect(() => {
    setFindings(new Map());
  }, [conversationId]);

  useEffect(() => {
    if (!enabled || !accessToken || !conversationId || !idsKey) return;
    let cancelled = false;
    aiService
      .safetyScan(accessToken, conversationId, idsKey.split(","))
      .then((results) => {
        if (!cancelled) setFindings(new Map(results.map((finding) => [finding.messageId, finding])));
      })
      .catch(() => undefined); // Warnings are best-effort; a failed scan just shows none.
    return () => {
      cancelled = true;
    };
  }, [enabled, accessToken, conversationId, idsKey]);

  const markHandled = useCallback((messageId: string) => {
    setFindings((prev) => {
      const next = new Map(prev);
      next.delete(messageId);
      return next;
    });
  }, []);

  return { findings: enabled ? findings : new Map<string, SafetyFinding>(), markHandled };
}
