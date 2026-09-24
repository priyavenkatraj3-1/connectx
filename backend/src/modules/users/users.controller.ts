import type { Response } from "express";
import type { AuthenticatedRequest } from "../../middleware/requireAuth";
import type { UsersService } from "./users.service";
import type { UpdateProfileInput } from "./users.validation";

export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  getMe = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const profile = await this.usersService.getOwnProfile(req.user!.userId);
    res.status(200).json(profile);
  };

  updateMe = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const profile = await this.usersService.updateOwnProfile(req.user!.userId, req.body as UpdateProfileInput);
    res.status(200).json(profile);
  };

  getById = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const profile = await this.usersService.getPublicProfile(req.params.userId as string);
    res.status(200).json(profile);
  };

  search = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const query = req.query.q as string;
    const results = await this.usersService.search(query, req.user!.userId);
    res.status(200).json({ results });
  };
}
