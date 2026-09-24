import { Router } from "express";
import { requireAuth } from "../../middleware/requireAuth";
import { notImplemented } from "../../utils/notImplemented";

export const privacyRouter = Router();

privacyRouter.get("/", requireAuth, notImplemented("Get privacy settings"));
privacyRouter.patch("/", requireAuth, notImplemented("Update privacy settings"));
