export type GroupRole = "owner" | "admin" | "member";

export interface GroupDTO {
  id: string;
  conversationId: string;
  name: string;
  description: string | null;
  avatarUrl: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  memberCount: number;
  myRole: GroupRole;
}

export interface GroupMemberDTO {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  statusMessage: string | null;
  role: GroupRole;
  joinedAt: string;
  addedBy: string | null;
}

export interface GroupDetails {
  group: GroupDTO;
  members: GroupMemberDTO[];
}

export interface CreateGroupPayload {
  name: string;
  description?: string;
  memberIds: string[];
}

export interface UpdateGroupPayload {
  name?: string;
  description?: string | null;
  avatarUrl?: string | null;
}
