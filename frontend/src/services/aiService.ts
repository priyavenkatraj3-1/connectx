import type {
  AIAction,
  AIMemory,
  AISettings,
  AISettingsResponse,
  ActionStatus,
  ActionUpdate,
  AskResult,
  DecisionMode,
  DecisionSummary,
  MemoryType,
  SafetyFinding,
  ScamCheckResult,
  TranslationResult,
  VoiceResult,
} from "../types/ai";
import { apiRequest, buildQueryString } from "./apiClient";

export type AISettingsUpdate = Partial<Omit<AISettings, "consentedAt">>;

/**
 * Phase 5 AI API. Consent, provider configuration and access control are
 * all enforced by the server; this client only calls it and shows what it
 * returns. Errors arrive as ApiError with a machine-readable `code`
 * (see utils/aiErrors.ts).
 */
export const aiService = {
  getSettings(accessToken: string): Promise<AISettingsResponse> {
    return apiRequest<AISettingsResponse>("/ai/settings", { accessToken });
  },

  updateSettings(accessToken: string, update: AISettingsUpdate): Promise<AISettingsResponse> {
    return apiRequest<AISettingsResponse>("/ai/settings", { method: "PATCH", body: update, accessToken });
  },

  async listExclusions(accessToken: string): Promise<string[]> {
    const { conversationIds } = await apiRequest<{ conversationIds: string[] }>("/ai/exclusions", { accessToken });
    return conversationIds;
  },

  async setExclusion(accessToken: string, conversationId: string, excluded: boolean): Promise<string[]> {
    const { conversationIds } = await apiRequest<{ conversationIds: string[] }>(`/ai/exclusions/${conversationId}`, {
      method: excluded ? "PUT" : "DELETE",
      accessToken,
    });
    return conversationIds;
  },

  ask(accessToken: string, input: { question: string; conversationIds: string[]; useMemory?: boolean }): Promise<AskResult> {
    return apiRequest<AskResult>("/ai/ask", { method: "POST", body: input, accessToken });
  },

  listMemories(accessToken: string): Promise<{ enabled: boolean; items: AIMemory[] }> {
    return apiRequest<{ enabled: boolean; items: AIMemory[] }>("/ai/memories", { accessToken });
  },

  async createMemory(
    accessToken: string,
    input: { type: MemoryType; content: string; sourceMessageId?: string }
  ): Promise<AIMemory> {
    const { memory } = await apiRequest<{ memory: AIMemory }>("/ai/memories", { method: "POST", body: input, accessToken });
    return memory;
  },

  deleteMemory(accessToken: string, memoryId: string): Promise<void> {
    return apiRequest<void>(`/ai/memories/${memoryId}`, { method: "DELETE", accessToken });
  },

  async clearMemories(accessToken: string): Promise<number> {
    const { deleted } = await apiRequest<{ deleted: number }>("/ai/memories", { method: "DELETE", accessToken });
    return deleted;
  },

  extractActions(
    accessToken: string,
    conversationId: string,
    input: { messageIds?: string[]; timezone?: string } = {}
  ): Promise<{ actions: AIAction[]; generatedBy: AskResult["generatedBy"]; messageCount: number }> {
    return apiRequest(`/ai/conversations/${conversationId}/actions/extract`, { method: "POST", body: input, accessToken });
  },

  async listActions(accessToken: string, filters: { status?: ActionStatus; conversationId?: string } = {}): Promise<AIAction[]> {
    const { actions } = await apiRequest<{ actions: AIAction[] }>(`/ai/actions${buildQueryString(filters)}`, { accessToken });
    return actions;
  },

  async updateAction(accessToken: string, actionId: string, update: ActionUpdate): Promise<AIAction> {
    const { action } = await apiRequest<{ action: AIAction }>(`/ai/actions/${actionId}`, { method: "PATCH", body: update, accessToken });
    return action;
  },

  async confirmAction(accessToken: string, actionId: string): Promise<AIAction> {
    const { action } = await apiRequest<{ action: AIAction }>(`/ai/actions/${actionId}/confirm`, { method: "POST", accessToken });
    return action;
  },

  async dismissAction(accessToken: string, actionId: string): Promise<AIAction> {
    const { action } = await apiRequest<{ action: AIAction }>(`/ai/actions/${actionId}/dismiss`, { method: "POST", accessToken });
    return action;
  },

  decisionSummary(accessToken: string, conversationId: string, mode: DecisionMode): Promise<DecisionSummary> {
    return apiRequest<DecisionSummary>(`/ai/conversations/${conversationId}/decision-summary`, {
      method: "POST",
      body: { mode },
      accessToken,
    });
  },

  translate(accessToken: string, messageId: string, targetLanguage: string): Promise<TranslationResult> {
    return apiRequest<TranslationResult>(`/ai/messages/${messageId}/translate`, {
      method: "POST",
      body: { targetLanguage },
      accessToken,
    });
  },

  async safetyScan(accessToken: string, conversationId: string, messageIds: string[]): Promise<SafetyFinding[]> {
    const { findings } = await apiRequest<{ findings: SafetyFinding[] }>(`/ai/conversations/${conversationId}/safety-scan`, {
      method: "POST",
      body: { messageIds },
      accessToken,
    });
    return findings;
  },

  scamCheck(accessToken: string, messageId: string): Promise<ScamCheckResult> {
    return apiRequest<ScamCheckResult>(`/ai/messages/${messageId}/scam-check`, { method: "POST", accessToken });
  },

  safetyFeedback(accessToken: string, messageId: string, action: "dismissed" | "reported"): Promise<void> {
    return apiRequest<void>(`/ai/messages/${messageId}/safety-feedback`, { method: "POST", body: { action }, accessToken });
  },

  async getVoice(accessToken: string, attachmentId: string): Promise<VoiceResult | null> {
    const { result } = await apiRequest<{ result: VoiceResult | null }>(`/ai/voice/${attachmentId}`, { accessToken });
    return result;
  },

  async transcribe(accessToken: string, attachmentId: string, languageHint?: string): Promise<VoiceResult> {
    const { result } = await apiRequest<{ result: VoiceResult }>(`/ai/voice/${attachmentId}/transcribe`, {
      method: "POST",
      body: languageHint ? { languageHint } : {},
      accessToken,
    });
    return result;
  },

  async analyzeVoice(accessToken: string, attachmentId: string): Promise<VoiceResult> {
    const { result } = await apiRequest<{ result: VoiceResult }>(`/ai/voice/${attachmentId}/analyze`, { method: "POST", accessToken });
    return result;
  },
};
