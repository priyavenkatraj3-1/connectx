/**
 * "Group Decision AI" — summarizes long group discussions, surfaces
 * options that were discussed, and lists what remains unresolved.
 *
 * Implementations MUST NOT claim a decision was made unless the source
 * messages clearly show one. See docs/ai-roadmap.md.
 */
export interface ConversationSummaryRequest {
  conversationId: string;
  requestingUserId: string;
  sinceMessageId?: string;
}

export interface ConversationSummaryResult {
  summary: string;
  optionsDiscussed: string[];
  unresolvedQuestions: string[];
  decisionsMade: string[]; // must remain empty unless the transcript clearly shows a decision
}

export interface SummarizationService {
  summarizeConversation(request: ConversationSummaryRequest): Promise<ConversationSummaryResult>;
}
