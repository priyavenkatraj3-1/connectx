import type { ConversationSummary, LastMessagePreview } from "../types/conversation";
import type { GroupRole } from "../types/group";

export function getConversationTitle(conversation: ConversationSummary): string {
  if (conversation.type === "group") return conversation.group?.name ?? "Group";
  return conversation.otherParticipant?.displayName ?? "Conversation";
}

export function getConversationAvatarUrl(conversation: ConversationSummary): string | undefined {
  if (conversation.type === "group") return conversation.group?.avatarUrl ?? undefined;
  return conversation.otherParticipant?.avatarUrl ?? undefined;
}

const MEDIA_LABELS: Record<string, string> = {
  image: "Photo",
  video: "Video",
  audio: "Audio",
  file: "File",
};

/** Text for a message whose body may be empty (media without a caption). */
export function describeMessageContent(contentType: string, body: string | null): string {
  const label = MEDIA_LABELS[contentType];
  if (label && body) return `${label}: ${body}`;
  if (label) return label;
  return body ?? "";
}

/** "You: …" for your own messages; "Alice: …" for others' messages in groups. */
export function formatLastMessagePreview(
  conversation: ConversationSummary,
  lastMessage: LastMessagePreview | null,
  currentUserId: string | undefined
): string {
  if (!lastMessage) return "No messages yet";
  const content = describeMessageContent(lastMessage.contentType, lastMessage.body);
  if (lastMessage.senderId === currentUserId) return `You: ${content}`;
  if (conversation.type === "group" && lastMessage.senderDisplayName) {
    return `${lastMessage.senderDisplayName}: ${content}`;
  }
  return content;
}

/**
 * UI mirror of the server's group permission table (backend
 * GroupsService). These only decide which controls to show — every action
 * is authorized again on the server.
 */
export const groupPermissions = {
  canEditDetails: (role: GroupRole | undefined) => role === "owner" || role === "admin",
  canAddMembers: (role: GroupRole | undefined) => role === "owner" || role === "admin",
  canChangeRoles: (role: GroupRole | undefined) => role === "owner",
  canRemove: (actorRole: GroupRole | undefined, targetRole: GroupRole) => {
    if (targetRole === "owner") return false;
    if (targetRole === "admin") return actorRole === "owner";
    return actorRole === "owner" || actorRole === "admin";
  },
};

export const ROLE_LABELS: Record<GroupRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};
