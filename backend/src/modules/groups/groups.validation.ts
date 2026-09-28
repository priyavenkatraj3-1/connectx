import { z } from "zod";
import { MAX_GROUP_MEMBERS } from "./groups.types";

const groupName = z.string().trim().min(1, "Group name is required").max(120, "Group name is too long");
const groupDescription = z.string().trim().max(500, "Description is too long");
/** Avatar "foundation": an http(s) URL, same as user profile avatars. Uploading an avatar file is a later phase. */
const avatarUrl = z
  .string()
  .trim()
  .url("avatarUrl must be a valid URL")
  .refine((value) => /^https?:\/\//i.test(value), "avatarUrl must be an http(s) URL");
const userIds = z
  .array(z.string().uuid("userIds must contain valid user IDs"))
  .min(1, "Select at least one person")
  .max(MAX_GROUP_MEMBERS - 1, `A group can have at most ${MAX_GROUP_MEMBERS} members`);

export const createGroupSchema = z.object({
  name: groupName,
  description: groupDescription.optional(),
  avatarUrl: avatarUrl.optional(),
  memberIds: userIds,
});

export const updateGroupSchema = z
  .object({
    name: groupName.optional(),
    description: groupDescription.nullable().optional(),
    avatarUrl: avatarUrl.nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: "No fields to update" });

export const addMembersSchema = z.object({
  userIds,
});

export const changeRoleSchema = z.object({
  role: z.enum(["admin", "member"], { message: "role must be 'admin' or 'member'" }),
});

export const groupParamsSchema = z.object({
  groupId: z.string().uuid("groupId must be a valid ID"),
});

export const groupMemberParamsSchema = z.object({
  groupId: z.string().uuid("groupId must be a valid ID"),
  userId: z.string().uuid("userId must be a valid ID"),
});

export type CreateGroupInput = z.infer<typeof createGroupSchema>;
export type UpdateGroupInput = z.infer<typeof updateGroupSchema>;
export type AddMembersInput = z.infer<typeof addMembersSchema>;
export type ChangeRoleInput = z.infer<typeof changeRoleSchema>;
