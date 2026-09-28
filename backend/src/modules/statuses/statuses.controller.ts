import type { Response } from "express";
import type { AuthenticatedRequest } from "../../middleware/requireAuth";
import type { StatusesService } from "./statuses.service";
import type { CreateStatusInput, StatusPrivacyInput } from "./statuses.validation";

export class StatusesController {
  constructor(private readonly statusesService: StatusesService) {}

  list = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    res.status(200).json(await this.statusesService.list(req.user!.userId));
  };

  create = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const status = await this.statusesService.create(req.user!.userId, req.body as CreateStatusInput);
    res.status(201).json({ status });
  };

  get = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const status = await this.statusesService.get(req.params.statusId as string, req.user!.userId);
    res.status(200).json({ status });
  };

  markViewed = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    res.status(200).json(await this.statusesService.markViewed(req.params.statusId as string, req.user!.userId));
  };

  listViewers = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const viewers = await this.statusesService.listViewers(req.params.statusId as string, req.user!.userId);
    res.status(200).json({ viewers });
  };

  remove = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    await this.statusesService.delete(req.params.statusId as string, req.user!.userId);
    res.status(204).send();
  };

  getPrivacy = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    res.status(200).json({ privacy: await this.statusesService.getPrivacySettings(req.user!.userId) });
  };

  updatePrivacy = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const privacy = await this.statusesService.updatePrivacySettings(req.user!.userId, req.body as StatusPrivacyInput);
    res.status(200).json({ privacy });
  };
}
