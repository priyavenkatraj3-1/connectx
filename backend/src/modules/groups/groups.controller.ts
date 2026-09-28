import type { Response } from "express";
import type { AuthenticatedRequest } from "../../middleware/requireAuth";
import type { GroupsService } from "./groups.service";
import type { AddMembersInput, ChangeRoleInput, CreateGroupInput, UpdateGroupInput } from "./groups.validation";

export class GroupsController {
  constructor(private readonly groupsService: GroupsService) {}

  create = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const details = await this.groupsService.createGroup(req.user!.userId, req.body as CreateGroupInput);
    res.status(201).json(details);
  };

  get = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const details = await this.groupsService.getGroup(req.params.groupId as string, req.user!.userId);
    res.status(200).json(details);
  };

  update = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const details = await this.groupsService.updateGroup(
      req.params.groupId as string,
      req.user!.userId,
      req.body as UpdateGroupInput
    );
    res.status(200).json(details);
  };

  listMembers = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const members = await this.groupsService.listMembers(req.params.groupId as string, req.user!.userId);
    res.status(200).json({ members });
  };

  addMembers = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const details = await this.groupsService.addMembers(
      req.params.groupId as string,
      req.user!.userId,
      req.body as AddMembersInput
    );
    res.status(200).json(details);
  };

  removeMember = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const details = await this.groupsService.removeMember(
      req.params.groupId as string,
      req.user!.userId,
      req.params.userId as string
    );
    res.status(200).json(details);
  };

  changeRole = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { role } = req.body as ChangeRoleInput;
    const details = await this.groupsService.changeRole(
      req.params.groupId as string,
      req.user!.userId,
      req.params.userId as string,
      role
    );
    res.status(200).json(details);
  };

  leave = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const result = await this.groupsService.leaveGroup(req.params.groupId as string, req.user!.userId);
    res.status(200).json(result);
  };
}
