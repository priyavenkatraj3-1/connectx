/**
 * "Scam/Spam Shield" — flags suspicious links or messages and explains why.
 * Implementations MUST require sufficient evidence before labeling
 * something a scam, and must always include a human-readable reason so the
 * user can judge for themselves rather than trust a bare verdict.
 */
export type SpamShieldVerdict = "safe" | "suspicious" | "likely_scam";

export interface SpamShieldRequest {
  messageId: string;
  text: string;
}

export interface SpamShieldResult {
  verdict: SpamShieldVerdict;
  confidence: number; // 0-1
  reasons: string[]; // empty only when verdict is "safe"
}

export interface SpamShieldService {
  analyzeMessage(request: SpamShieldRequest): Promise<SpamShieldResult>;
}
