import { Router } from "express";
import { requireAuth } from "../../middleware/requireAuth";
import { notImplemented } from "../../utils/notImplemented";

export const groupsRouter = Router();

groupsRouter.post("/", requireAuth, notImplemented("Create group"));
groupsRouter.post("/:groupId/members", requireAuth, notImplemented("Add group member"));
groupsRouter.delete("/:groupId/members/:userId", requireAuth, notImplemented("Remove group member"));
groupsRouter.get("/:groupId/members", requireAuth, notImplemented("List group members"));
