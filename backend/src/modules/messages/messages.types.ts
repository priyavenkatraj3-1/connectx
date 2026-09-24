export type MessageStatus = "sent" | "delivered" | "read";

export interface MessageDTO {
  id: string;
  conversationId: string;
  senderId: string;
  contentType: string;
  body: string | null;
  status: MessageStatus;
  createdAt: Date;
  editedAt: Date | null;
}

export interface MessagePage {
  items: MessageDTO[];
  hasMore: boolean;
}
