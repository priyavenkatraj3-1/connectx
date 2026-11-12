import type { Response } from "express";
import type { AuthenticatedRequest } from "../../middleware/requireAuth";
import type { AISettingsService } from "./ai-settings.service";
import type { SmartActionsService } from "./features/actions.service";
import type { AskYourChatsService } from "./features/ask.service";
import type { GroupDecisionService } from "./features/group-decision.service";
import type { AIMemoryService } from "./features/memory.service";
import type { ScamShieldService } from "./features/scam-shield.service";
import type { TranslationService } from "./features/translation.service";
import type { VoiceIntelligenceService } from "./features/voice.service";
import {
  type ActionUpdateInput,
  type AskInput,
  type DecisionSummaryInput,
  type ExtractActionsInput,
  listActionsQuerySchema,
  type MemoryCreateInput,
  type SettingsUpdateInput,
} from "./ai.validation";

export interface AIServices {
  settings: AISettingsService;
  ask: AskYourChatsService;
  memory: AIMemoryService;
  actions: SmartActionsService;
  groupDecision: GroupDecisionService;
  translation: TranslationService;
  scamShield: ScamShieldService;
  voice: VoiceIntelligenceService;
}

/** Thin HTTP layer: identity always comes from the verified token (`req.user`), never from the body. */
export class AIController {
  constructor(private readonly services: AIServices) {}

  private userId(req: AuthenticatedRequest): string {
    return req.user!.userId;
  }

  getSettings = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const settings = await this.services.settings.getSettings(this.userId(req));
    res.status(200).json({ settings, ...this.services.settings.getServerStatus() });
  };

  updateSettings = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const settings = await this.services.settings.updateSettings(this.userId(req), req.body as SettingsUpdateInput);
    res.status(200).json({ settings, ...this.services.settings.getServerStatus() });
  };

  listExclusions = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    res.status(200).json({ conversationIds: await this.services.settings.listExclusions(this.userId(req)) });
  };

  addExclusion = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const ids = await this.services.settings.setExclusion(this.userId(req), req.params.conversationId as string, true);
    res.status(200).json({ conversationIds: ids });
  };

  removeExclusion = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const ids = await this.services.settings.setExclusion(this.userId(req), req.params.conversationId as string, false);
    res.status(200).json({ conversationIds: ids });
  };

  ask = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const result = await this.services.ask.ask(this.userId(req), req.body as AskInput);
    res.status(200).json(result);
  };

  listMemories = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    res.status(200).json(await this.services.memory.list(this.userId(req)));
  };

  createMemory = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const memory = await this.services.memory.create(this.userId(req), req.body as MemoryCreateInput);
    res.status(201).json({ memory });
  };

  deleteMemory = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    await this.services.memory.remove(this.userId(req), req.params.memoryId as string);
    res.status(204).send();
  };

  clearMemories = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const deleted = await this.services.memory.clear(this.userId(req));
    res.status(200).json({ deleted });
  };

  extractActions = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const result = await this.services.actions.extract(
      this.userId(req),
      req.params.conversationId as string,
      req.body as ExtractActionsInput
    );
    res.status(200).json(result);
  };

  listActions = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const filters = listActionsQuerySchema.parse(req.query);
    res.status(200).json({ actions: await this.services.actions.list(this.userId(req), filters) });
  };

  updateAction = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const body = req.body as ActionUpdateInput;
    const action = await this.services.actions.update(this.userId(req), req.params.actionId as string, {
      ...body,
      dueAt: body.dueAt === undefined ? undefined : body.dueAt === null ? null : new Date(body.dueAt),
    });
    res.status(200).json({ action });
  };

  confirmAction = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    res.status(200).json({ action: await this.services.actions.confirm(this.userId(req), req.params.actionId as string) });
  };

  dismissAction = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    res.status(200).json({ action: await this.services.actions.dismiss(this.userId(req), req.params.actionId as string) });
  };

  decisionSummary = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { mode } = req.body as DecisionSummaryInput;
    const result = await this.services.groupDecision.summarize(this.userId(req), req.params.conversationId as string, mode);
    res.status(200).json(result);
  };

  translate = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { targetLanguage } = req.body as { targetLanguage: string };
    const result = await this.services.translation.translate(this.userId(req), req.params.messageId as string, targetLanguage);
    res.status(200).json(result);
  };

  safetyScan = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { messageIds } = req.body as { messageIds: string[] };
    const findings = await this.services.scamShield.scan(this.userId(req), req.params.conversationId as string, messageIds);
    res.status(200).json({ findings });
  };

  scamCheck = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    res.status(200).json(await this.services.scamShield.aiCheck(this.userId(req), req.params.messageId as string));
  };

  safetyFeedback = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { action } = req.body as { action: "dismissed" | "reported" };
    await this.services.scamShield.feedback(this.userId(req), req.params.messageId as string, action);
    res.status(204).send();
  };

  getVoice = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    res.status(200).json({ result: await this.services.voice.get(this.userId(req), req.params.attachmentId as string) });
  };

  transcribe = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { languageHint } = req.body as { languageHint?: string };
    const result = await this.services.voice.transcribe(this.userId(req), req.params.attachmentId as string, languageHint);
    res.status(200).json({ result });
  };

  analyzeVoice = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    res.status(200).json({ result: await this.services.voice.analyze(this.userId(req), req.params.attachmentId as string) });
  };

  translateVoice = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { targetLanguage } = req.body as { targetLanguage: string };
    const translation = await this.services.voice.translate(this.userId(req), req.params.attachmentId as string, targetLanguage);
    res.status(200).json({ translation });
  };

  listVoiceTranslations = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const translations = await this.services.voice.listTranslations(this.userId(req), req.params.attachmentId as string);
    res.status(200).json({ translations });
  };
}
