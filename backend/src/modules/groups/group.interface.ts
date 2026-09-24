export type GroupMemberRole = "owner" | "admin" | "member";

export interface Group {
  id: string;
  conversationId: string;
  name: string;
  description: string | null;
  avatarUrl: string | null;
  createdBy: string;
  createdAt: Date;
}

/**
 * Contract for group and community management. Implemented in a later
 * phase once the `groups` and `group_members` tables are backed by a real
 * database.
 */
export interface GroupService {
  createGroup(input: { name: string; description?: string; createdBy: string }): Promise<Group>;
  addMember(groupId: string, userId: string, addedBy: string, role?: GroupMemberRole): Promise<void>;
  removeMember(groupId: string, userId: string, removedBy: string): Promise<void>;
  listMembers(groupId: string): Promise<Array<{ userId: string; role: GroupMemberRole }>>;
}
