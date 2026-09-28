import type { Response } from "express";
import type { AuthenticatedRequest } from "../../middleware/requireAuth";
import type { CallsService } from "./calls.service";
import { activeCallQuerySchema, callHistoryQuerySchema, type StartCallInput } from "./calls.validation";

export class CallsController {
  constructor(private readonly callsService: CallsService) {}

  iceServers = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    // Short-lived TURN credentials must not be cached by intermediaries.
    res.setHeader("Cache-Control", "private, no-store");
    res.status(200).json({ iceServers: this.callsService.getIceServers(req.user!.userId) });
  };

  start = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const call = await this.callsService.startCall(req.user!.userId, req.body as StartCallInput);
    res.status(201).json({ call });
  };

  history = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const query = callHistoryQuerySchema.parse(req.query);
    const calls = await this.callsService.listHistory(req.user!.userId, query);
    res.status(200).json({ calls });
  };

  active = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { conversationId } = activeCallQuerySchema.parse(req.query);
    const call = await this.callsService.getActiveCall(conversationId, req.user!.userId);
    res.status(200).json({ call });
  };

  get = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const call = await this.callsService.getCall(req.params.callId as string, req.user!.userId);
    res.status(200).json({ call });
  };

  end = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const call = await this.callsService.hangUp(req.user!.userId, req.params.callId as string);
    res.status(200).json({ call });
  };
}
