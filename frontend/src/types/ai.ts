/** Mirrors backend/src/modules/ai/ai.types.ts and the AI API responses (docs/api.md). */

export interface AISettings {
  aiFeaturesEnabled: boolean;
  aiMemoryEnabled: boolean;
  chatRetrievalEnabled: boolean;
  spamShieldEnabled: boolean;
  voiceEnabled: boolean;
  preferredLanguage: string;
  consentedAt: string | null;
}

export interface AIServerStatus {
  provider: { name: string; configured: boolean; model: string | null };
  transcription: { name: string; configured: boolean };
  supportedLanguages: Array<{ code: string; name: string }>;
  dataSharing: string[];
}

export interface AISettingsResponse extends AIServerStatus {
  settings: AISettings;
}

export interface AIGeneratedBy {
  provider: string;
  model: string;
}

export interface AISourceReference {
  ref: string;
  messageId: string;
  conversationId: string;
  conversationTitle: string;
  senderName: string;
  createdAt: string;
  excerpt: string;
}

export interface AskResult {
  status: "answered" | "insufficient_information";
  answer: string;
  sources: AISourceReference[];
  generatedBy: AIGeneratedBy | null;
  contextMessageCount: number;
  usedMemory: boolean;
}

export type MemoryType = "preference" | "fact" | "context" | "working";

export interface AIMemory {
  id: string;
  type: MemoryType;
  content: string;
  sourceConversationId: string | null;
  sourceMessageId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ActionType = "task" | "reminder" | "deadline" | "event" | "follow_up" | "action_item";
export type ActionStatus = "suggested" | "confirmed" | "dismissed";

export interface AIAction {
  id: string;
  conversationId: string | null;
  sourceMessageId: string | null;
  type: ActionType;
  title: string;
  notes: string | null;
  dueAt: string | null;
  dueText: string | null;
  timezone: string | null;
  participants: string[];
  confidence: "low" | "medium" | "high" | null;
  explanation: string | null;
  status: ActionStatus;
  confirmedAt: string | null;
  /** Phase 6: set once you turned this suggestion into a task/reminder/event. Optional for older payloads. */
  convertedTo?: "task" | "reminder" | "event" | null;
  convertedId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ActionUpdate {
  type?: ActionType;
  title?: string;
  notes?: string | null;
  dueAt?: string | null;
  dueText?: string | null;
  timezone?: string | null;
}

export type DecisionMode = "summary" | "decisions" | "open_issues";

export interface DecisionPoint {
  text: string;
  sources: AISourceReference[];
}

export interface DecisionSummary {
  mode: DecisionMode;
  hasContent: boolean;
  summary: string;
  proposals: DecisionPoint[];
  agreements: DecisionPoint[];
  disagreements: DecisionPoint[];
  openQuestions: DecisionPoint[];
  decisions: DecisionPoint[];
  actionItems: DecisionPoint[];
  generatedBy: AIGeneratedBy | null;
  messageCount: number;
  droppedUnsupportedItems: number;
}

export interface TranslationResult {
  messageId: string;
  targetLanguage: string;
  translatedText: string;
  detectedSourceLanguage: string | null;
  cached: boolean;
  generatedBy: AIGeneratedBy | null;
}

export type RiskLevel = "likely_safe" | "suspicious" | "high_risk";

export interface ScamSignal {
  type: string;
  description: string;
}

export interface SafetyFinding {
  messageId: string;
  riskLevel: RiskLevel;
  signals: ScamSignal[];
  links: Array<{ url: string; reasons: string[] }>;
}

export interface ScamCheckResult {
  messageId: string;
  riskLevel: RiskLevel;
  heuristic: Omit<SafetyFinding, "messageId">;
  ai: { riskLevel: RiskLevel; reasons: string[]; confidence: "low" | "medium" | "high" } | null;
  generatedBy: AIGeneratedBy | null;
  disclaimer: string;
}

export type VoiceStatus = "transcribing" | "processing" | "complete" | "failed";

export interface VoiceResult {
  attachmentId: string;
  status: VoiceStatus;
  transcript: string | null;
  detectedLanguage: string | null;
  summary: string | null;
  actionItems: string[];
  errorMessage: string | null;
  updatedAt: string;
}
