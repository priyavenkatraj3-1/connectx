/**
 * "Voice Intelligence" — transcribes voice messages and derives a summary,
 * key points, and action items from the transcript.
 */
export interface VoiceIntelligenceRequest {
  attachmentId: string;
  requestingUserId: string;
}

export interface VoiceIntelligenceResult {
  transcript: string;
  summary: string;
  keyPoints: string[];
  actionItems: string[];
}

export interface VoiceIntelligenceService {
  process(request: VoiceIntelligenceRequest): Promise<VoiceIntelligenceResult>;
}
