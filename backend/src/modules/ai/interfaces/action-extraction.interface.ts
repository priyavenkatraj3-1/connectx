/**
 * "Smart Action Extraction" — detects possible tasks, reminders, dates, and
 * events from conversation text. Implementations MUST treat every
 * extracted item as a suggestion: the user must explicitly confirm before
 * any external action (calendar event, reminder, task) is actually created.
 */
export type SuggestedActionType = "task" | "reminder" | "event";

export interface SuggestedAction {
  id: string;
  type: SuggestedActionType;
  title: string;
  dueDate: Date | null;
  sourceMessageId: string;
  confirmed: boolean; // always starts false; set true only via explicit user confirmation
}

export interface ActionExtractionService {
  extractFromConversation(conversationId: string, requestingUserId: string): Promise<SuggestedAction[]>;
  confirmAction(actionId: string, userId: string): Promise<SuggestedAction>;
}
