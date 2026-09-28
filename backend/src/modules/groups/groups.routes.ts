import { Router } from "express";
import { requireAuth } from "../../middleware/requireAuth";
import { validateBody, validateParams } from "../../middleware/validate";
import { asyncHandler } from "../../utils/asyncHandler";
import { GroupsController } from "./groups.controller";
import type { GroupsService } from "./groups.service";
import {
  addMembersSchema,
  changeRoleSchema,
  createGroupSchema,
  groupMemberParamsSchema,
  groupParamsSchema,
  updateGroupSchema,
} from "./groups.validation";

/** All authorization (membership + role checks) happens in GroupsService — see the permission table there. */
export function createGroupsRouter(groupsService: GroupsService): Router {
  const controller = new GroupsController(groupsService);
  const router = Router();
  const groupParams = validateParams(groupParamsSchema);
  const memberParams = validateParams(groupMemberParamsSchema);

  router.post("/", requireAuth, validateBody(createGroupSchema), asyncHandler(controller.create));
  router.get("/:groupId", requireAuth, groupParams, asyncHandler(controller.get));
  router.patch("/:groupId", requireAuth, groupParams, validateBody(updateGroupSchema), asyncHandler(controller.update));
  router.get("/:groupId/members", requireAuth, groupParams, asyncHandler(controller.listMembers));
  router.post(
    "/:groupId/members",
    requireAuth,
    groupParams,
    validateBody(addMembersSchema),
    asyncHandler(controller.addMembers)
  );
  router.delete("/:groupId/members/:userId", requireAuth, memberParams, asyncHandler(controller.removeMember));
  router.patch(
    "/:groupId/members/:userId/role",
    requireAuth,
    memberParams,
    validateBody(changeRoleSchema),
    asyncHandler(controller.changeRole)
  );
  router.post("/:groupId/leave", requireAuth, groupParams, asyncHandler(controller.leave));

  return router;
}
