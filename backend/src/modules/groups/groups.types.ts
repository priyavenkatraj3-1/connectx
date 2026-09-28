export type GroupRole = "owner" | "admin" | "member";

export interface GroupDTO {
  id: string;
  conversationId: string;
  name: string;
  description: string | null;
  avatarUrl: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  memberCount: number;
  /** The requesting user's role in this group. */
  myRole: GroupRole;
}

export interface GroupMemberDTO {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  statusMessage: string | null;
  role: GroupRole;
  joinedAt: Date;
  addedBy: string | null;
}

export interface GroupDetails {
  group: GroupDTO;
  members: GroupMemberDTO[];
}

/** Maximum members in one group, owner included. */
export const MAX_GROUP_MEMBERS = 256;
