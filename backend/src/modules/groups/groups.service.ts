import { AppError } from "../../middleware/errorHandler";
import { broadcast } from "../../realtime/broadcast";
import type { RealtimeGateway } from "../../realtime/gateway.interface";
import type { UsersRepository } from "../users/users.repository";
import { DuplicateMemberError, type GroupRecord, type GroupsRepository } from "./groups.repository";
import { MAX_GROUP_MEMBERS, type GroupDetails, type GroupDTO, type GroupMemberDTO, type GroupRole } from "./groups.types";
import type { AddMembersInput, CreateGroupInput, UpdateGroupInput } from "./groups.validation";

/**
 * Group permission rules (enforced here, on the server — the UI only
 * mirrors them):
 *
 *   action                       owner   admin   member
 *   view group / members           ✓       ✓       ✓
 *   edit name/description/avatar   ✓       ✓       ✗
 *   add members                    ✓       ✓       ✗
 *   remove a member                ✓       ✓       ✗
 *   remove an admin                ✓       ✗       ✗
 *   remove the owner               ✗       ✗       ✗
 *   promote/demote (admin⇄member)  ✓       ✗       ✗
 *   leave                          ✓ *     ✓       ✓
 *
 * * When the owner leaves, ownership passes to the longest-standing admin,
 *   or failing that the longest-standing member, atomically.
 */
export class GroupsService {
  constructor(
    private readonly groupsRepository: GroupsRepository,
    private readonly usersRepository: UsersRepository,
    private readonly realtimeGateway: RealtimeGateway
  ) {}

  private async loadGroupForMember(groupId: string, userId: string): Promise<{ group: GroupRecord; role: GroupRole }> {
    const group = await this.groupsRepository.findById(groupId);
    if (!group) throw new AppError("Group not found", 404);
    const role = await this.groupsRepository.getRole(groupId, userId);
    if (!role) throw new AppError("You are not a member of this group", 403);
    return { group, role };
  }

  private toDTO(group: GroupRecord, members: GroupMemberDTO[], myRole: GroupRole): GroupDTO {
    return { ...group, memberCount: members.length, myRole };
  }

  /** Validates that every ID is an existing, active user. Returns the de-duplicated list. */
  private async requireActiveUsers(userIds: string[]): Promise<string[]> {
    const unique = [...new Set(userIds)];
    const profiles = await this.usersRepository.findManyPublicProfiles(unique);
    const unknown = unique.filter((id) => !profiles.has(id));
    if (unknown.length > 0) {
      throw new AppError(`Unknown or inactive users: ${unknown.join(", ")}`, 400);
    }
    return unique;
  }

  async createGroup(ownerId: string, input: CreateGroupInput): Promise<GroupDetails> {
    const memberIds = (await this.requireActiveUsers(input.memberIds)).filter((id) => id !== ownerId);
    if (memberIds.length === 0) {
      throw new AppError("Add at least one other person to create a group", 400);
    }
    if (memberIds.length + 1 > MAX_GROUP_MEMBERS) {
      throw new AppError(`A group can have at most ${MAX_GROUP_MEMBERS} members`, 400);
    }

    const group = await this.groupsRepository.create({
      name: input.name,
      description: input.description ? input.description : null,
      avatarUrl: input.avatarUrl ?? null,
      ownerId,
      memberIds,
    });

    broadcast(this.realtimeGateway, [ownerId, ...memberIds], {
      type: "conversation:added",
      conversationId: group.conversationId,
    });

    return this.getGroup(group.id, ownerId);
  }

  async getGroup(groupId: string, userId: string): Promise<GroupDetails> {
    const { group, role } = await this.loadGroupForMember(groupId, userId);
    const members = await this.groupsRepository.listMembers(groupId);
    return { group: this.toDTO(group, members, role), members };
  }

  async listMembers(groupId: string, userId: string): Promise<GroupMemberDTO[]> {
    await this.loadGroupForMember(groupId, userId);
    return this.groupsRepository.listMembers(groupId);
  }

  async updateGroup(groupId: string, actorId: string, input: UpdateGroupInput): Promise<GroupDetails> {
    const { role } = await this.loadGroupForMember(groupId, actorId);
    if (role === "member") {
      throw new AppError("Only group owners and admins can edit group details", 403);
    }

    const updated = await this.groupsRepository.update(groupId, {
      name: input.name,
      description: input.description === "" ? null : input.description,
      avatarUrl: input.avatarUrl,
    });
    const members = await this.groupsRepository.listMembers(groupId);

    const { myRole: _omit, ...publicGroup } = this.toDTO(updated, members, role);
    broadcast(
      this.realtimeGateway,
      members.map((m) => m.userId),
      { type: "group:updated", conversationId: updated.conversationId, group: publicGroup }
    );

    return { group: this.toDTO(updated, members, role), members };
  }

  async addMembers(groupId: string, actorId: string, input: AddMembersInput): Promise<GroupDetails> {
    const { group, role } = await this.loadGroupForMember(groupId, actorId);
    if (role === "member") {
      throw new AppError("Only group owners and admins can add members", 403);
    }

    const userIds = await this.requireActiveUsers(input.userIds);
    const currentMembers = await this.groupsRepository.listMembers(groupId);
    const currentIds = new Set(currentMembers.map((m) => m.userId));

    const alreadyMembers = userIds.filter((id) => currentIds.has(id));
    if (alreadyMembers.length > 0) {
      throw new AppError(`Already a member of this group: ${alreadyMembers.join(", ")}`, 409);
    }
    if (currentMembers.length + userIds.length > MAX_GROUP_MEMBERS) {
      throw new AppError(`A group can have at most ${MAX_GROUP_MEMBERS} members`, 400);
    }

    try {
      await this.groupsRepository.addMembers(group, userIds, actorId);
    } catch (err) {
      // Lost a race with a concurrent add of the same user.
      if (err instanceof DuplicateMemberError) {
        throw new AppError(`Already a member of this group: ${err.userId}`, 409);
      }
      throw err;
    }

    const members = await this.groupsRepository.listMembers(groupId);
    broadcast(
      this.realtimeGateway,
      members.map((m) => m.userId),
      { type: "group:member_added", conversationId: group.conversationId, groupId, userIds, addedBy: actorId }
    );
    broadcast(this.realtimeGateway, userIds, { type: "conversation:added", conversationId: group.conversationId });

    return { group: this.toDTO(group, members, role), members };
  }

  async removeMember(groupId: string, actorId: string, targetUserId: string): Promise<GroupDetails> {
    if (targetUserId === actorId) {
      throw new AppError("Use the leave endpoint to leave a group", 400);
    }

    const { group, role: actorRole } = await this.loadGroupForMember(groupId, actorId);
    if (actorRole === "member") {
      throw new AppError("Only group owners and admins can remove members", 403);
    }

    const targetRole = await this.groupsRepository.getRole(groupId, targetUserId);
    if (!targetRole) {
      throw new AppError("That user is not a member of this group", 404);
    }
    if (targetRole === "owner") {
      throw new AppError("The group owner cannot be removed", 403);
    }
    if (targetRole === "admin" && actorRole !== "owner") {
      throw new AppError("Only the group owner can remove an admin", 403);
    }

    await this.groupsRepository.removeMember(group, targetUserId);

    const members = await this.groupsRepository.listMembers(groupId);
    broadcast(this.realtimeGateway, [...members.map((m) => m.userId), targetUserId], {
      type: "group:member_removed",
      conversationId: group.conversationId,
      groupId,
      userId: targetUserId,
      removedBy: actorId,
    });
    this.realtimeGateway.sendToUser(targetUserId, {
      type: "conversation:removed",
      conversationId: group.conversationId,
      reason: "removed",
    });

    return { group: this.toDTO(group, members, actorRole), members };
  }

  async leaveGroup(groupId: string, userId: string): Promise<{ newOwnerId: string | null }> {
    const { group, role } = await this.loadGroupForMember(groupId, userId);

    let successorId: string | null = null;
    if (role === "owner") {
      // listMembers is ordered owner → admins → members, each by join time.
      const others = (await this.groupsRepository.listMembers(groupId)).filter((m) => m.userId !== userId);
      successorId = others[0]?.userId ?? null;
    }

    await this.groupsRepository.removeMember(group, userId, successorId);

    const remaining = await this.groupsRepository.listMembers(groupId);
    broadcast(this.realtimeGateway, [...remaining.map((m) => m.userId), userId], {
      type: "group:member_left",
      conversationId: group.conversationId,
      groupId,
      userId,
      newOwnerId: successorId,
    });
    this.realtimeGateway.sendToUser(userId, {
      type: "conversation:removed",
      conversationId: group.conversationId,
      reason: "left",
    });

    return { newOwnerId: successorId };
  }

  async changeRole(groupId: string, actorId: string, targetUserId: string, newRole: "admin" | "member"): Promise<GroupDetails> {
    const { group, role: actorRole } = await this.loadGroupForMember(groupId, actorId);
    if (actorRole !== "owner") {
      throw new AppError("Only the group owner can change member roles", 403);
    }

    const targetRole = await this.groupsRepository.getRole(groupId, targetUserId);
    if (!targetRole) {
      throw new AppError("That user is not a member of this group", 404);
    }
    if (targetRole === "owner") {
      throw new AppError("The owner's role cannot be changed", 400);
    }

    if (targetRole !== newRole) {
      await this.groupsRepository.setRole(groupId, targetUserId, newRole);
      const memberIds = (await this.groupsRepository.listMembers(groupId)).map((m) => m.userId);
      broadcast(this.realtimeGateway, memberIds, {
        type: "group:role_changed",
        conversationId: group.conversationId,
        groupId,
        userId: targetUserId,
        role: newRole,
        changedBy: actorId,
      });
    }

    return this.getGroup(groupId, actorId);
  }
}
