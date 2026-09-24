export type NotificationType = "message" | "mention" | "group_invite" | "system";

export interface Notification {
  id: string;
  userId: string;
  type: NotificationType;
  payload: Record<string, unknown>;
  readAt: Date | null;
  createdAt: Date;
}

/**
 * Contract for in-app and push notifications. Implemented in a later phase
 * once a delivery mechanism (WebSocket push, web push, mobile push) is
 * wired up.
 */
export interface NotificationService {
  createNotification(input: {
    userId: string;
    type: NotificationType;
    payload: Record<string, unknown>;
  }): Promise<Notification>;
  listNotifications(userId: string, unreadOnly?: boolean): Promise<Notification[]>;
  markAsRead(notificationId: string, userId: string): Promise<void>;
}
