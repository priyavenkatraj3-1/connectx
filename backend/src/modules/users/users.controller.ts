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
    const profile = await this.usersService.getContactProfile(req.params.userId as string, req.user!.userId);
    res.status(200).json(profile);
  };

  uploadAvatar = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const profile = await this.usersService.setAvatar(req.user!.userId, data);
    res.status(200).json(profile);
  };

  removeAvatar = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const profile = await this.usersService.removeAvatar(req.user!.userId);
    res.status(200).json(profile);
  };

  /** Public (no token: <img> can't send one) — see UsersService.readAvatar for what's served. */
  getAvatar = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { data, mimeType } = await this.usersService.readAvatar(req.params.userId as string, req.params.avatarId as string);
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Content-Length", String(data.length));
    // The URL changes whenever the picture does, so it can be cached for good.
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    // Shown by the web app from another origin; still can't run as a page.
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.status(200).send(data);
  };

  search = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const query = req.query.q as string;
    const results = await this.usersService.search(query, req.user!.userId);
    res.status(200).json({ results });
  };
}
