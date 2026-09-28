import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { aiService, type AISettingsUpdate } from "../services/aiService";
import type { AISettings, AIServerStatus } from "../types/ai";
import { useAuth } from "./AuthContext";
import { useRealtime } from "./RealtimeContext";

interface AIContextValue {
  /** Null until loaded (or if loading failed). */
  settings: AISettings | null;
  server: AIServerStatus | null;
  /** Conversations the user excluded from AI. */
  exclusions: string[];
  isLoading: boolean;
  loadError: string | null;
  /** AI requests of this user currently in flight on any of their devices (from `ai:*` realtime events). */
  activeRequests: number;
  reload(): Promise<void>;
  updateSettings(update: AISettingsUpdate): Promise<void>;
  setExcluded(conversationId: string, excluded: boolean): Promise<void>;
  /** Convenience flags derived from settings + server status. They only drive UI; the server enforces all of it. */
  canUseProvider: boolean;
  canReadChats: boolean;
}

const AIContext = createContext<AIContextValue | undefined>(undefined);

export function AIProvider({ children }: { children: ReactNode }) {
  const { accessToken } = useAuth();
  const { subscribe } = useRealtime();
  const [settings, setSettings] = useState<AISettings | null>(null);
  const [server, setServer] = useState<AIServerStatus | null>(null);
  const [exclusions, setExclusions] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [inFlight, setInFlight] = useState<Set<string>>(new Set());

  const reload = useCallback(async () => {
    if (!accessToken) return;
    setIsLoading(true);
    setLoadError(null);
    try {
      const [response, excluded] = await Promise.all([aiService.getSettings(accessToken), aiService.listExclusions(accessToken)]);
      const { settings: loaded, ...status } = response;
      setSettings(loaded);
      setServer(status);
      setExclusions(excluded);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Couldn't load AI settings");
    } finally {
      setIsLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(
    () =>
      subscribe((event) => {
        if (event.type === "ai:processing") {
          setInFlight((prev) => new Set(prev).add(event.requestId));
        } else if (event.type === "ai:completed" || event.type === "ai:failed") {
          setInFlight((prev) => {
            if (!prev.has(event.requestId)) return prev;
            const next = new Set(prev);
            next.delete(event.requestId);
            return next;
          });
        }
      }),
    [subscribe]
  );

  const updateSettings = useCallback(
    async (update: AISettingsUpdate) => {
      if (!accessToken) return;
      const { settings: saved, ...status } = await aiService.updateSettings(accessToken, update);
      setSettings(saved);
      setServer(status);
    },
    [accessToken]
  );

  const setExcluded = useCallback(
    async (conversationId: string, excluded: boolean) => {
      if (!accessToken) return;
      setExclusions(await aiService.setExclusion(accessToken, conversationId, excluded));
    },
    [accessToken]
  );

  const value = useMemo<AIContextValue>(() => {
    const canUseProvider = !!settings?.aiFeaturesEnabled && !!server?.provider.configured;
    return {
      settings,
      server,
      exclusions,
      isLoading,
      loadError,
      activeRequests: inFlight.size,
      reload,
      updateSettings,
      setExcluded,
      canUseProvider,
      canReadChats: canUseProvider && !!settings?.chatRetrievalEnabled,
    };
  }, [settings, server, exclusions, isLoading, loadError, inFlight, reload, updateSettings, setExcluded]);

  return <AIContext.Provider value={value}>{children}</AIContext.Provider>;
}

export function useAI(): AIContextValue {
  const ctx = useContext(AIContext);
  if (!ctx) throw new Error("useAI must be used within an AIProvider");
  return ctx;
}

/** For components that also render outside the app shell (and in older tests): AI UI is simply hidden. */
export function useOptionalAI(): AIContextValue | undefined {
  return useContext(AIContext);
}
