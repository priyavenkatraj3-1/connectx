/** Feature names used for gating, usage logging and realtime status events. */
export type AIFeature =
  | "ask_your_chats"
  | "group_decision"
  | "action_extraction"
  | "translation"
  | "scam_shield"
  | "voice_transcription"
  | "voice_summary";

export interface AISettings {
  /** Master switch — nothing that uses an AI provider runs while this is off. */
  aiFeaturesEnabled: boolean;
  /** Consent to store and use explicit AI memory items. */
  aiMemoryEnabled: boolean;
  /** Allow AI features to read (retrieve from) your chats: Ask Your Chats, summaries, action extraction. */
  chatRetrievalEnabled: boolean;
  /** Local scam/spam warnings; the optional AI check additionally needs the master switch. */
  spamShieldEnabled: boolean;
  /** Consent to send voice messages you choose to a transcription provider. */
  voiceEnabled: boolean;
  preferredLanguage: string;
  consentedAt: Date | null;
}

export type MemoryType = "preference" | "fact" | "context" | "working";

export interface AIMemoryDTO {
  id: string;
  type: MemoryType;
  content: string;
  sourceConversationId: string | null;
  sourceMessageId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type ActionType = "task" | "reminder" | "deadline" | "event" | "follow_up" | "action_item";
export type ActionStatus = "suggested" | "confirmed" | "dismissed";
export type Confidence = "low" | "medium" | "high";

export interface AIActionDTO {
  id: string;
  conversationId: string | null;
  sourceMessageId: string | null;
  type: ActionType;
  title: string;
  notes: string | null;
  dueAt: Date | null;
  dueText: string | null;
  timezone: string | null;
  participants: string[];
  confidence: Confidence | null;
  explanation: string | null;
  status: ActionStatus;
  confirmedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A source message cited by an AI answer. Always a real message the requester can read — never model-invented. */
export interface AISourceReference {
  ref: string;
  messageId: string;
  conversationId: string;
  conversationTitle: string;
  senderName: string;
  createdAt: Date;
  excerpt: string;
}

export interface AIGeneratedBy {
  provider: string;
  model: string;
}

export type RiskLevel = "likely_safe" | "suspicious" | "high_risk";

export interface ScamSignal {
  type: "suspicious_link" | "credential_request" | "payment_request" | "urgency" | "impersonation" | "too_good_to_be_true";
  description: string;
}

export interface SuspiciousLink {
  url: string;
  reasons: string[];
}

export interface HeuristicScamResult {
  riskLevel: RiskLevel;
  signals: ScamSignal[];
  links: SuspiciousLink[];
}

export type VoiceStatus = "transcribing" | "processing" | "complete" | "failed";

export interface VoiceResultDTO {
  attachmentId: string;
  status: VoiceStatus;
  transcript: string | null;
  detectedLanguage: string | null;
  summary: string | null;
  actionItems: string[];
  errorMessage: string | null;
  updatedAt: Date;
}
