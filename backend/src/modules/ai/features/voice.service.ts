import { z } from "zod";
import { AppError } from "../../../middleware/errorHandler";
import type { MediaService } from "../../media/media.service";
import type { AttachmentDTO } from "../../media/media.types";
import type { AISettingsService } from "../ai-settings.service";
import type { AIGateway } from "../ai.gateway";
import type { AIRepository } from "../ai.repository";
import type { VoiceResultDTO } from "../ai.types";
import { renderSingleMessage, UNTRUSTED_DATA_RULES } from "../context/prompt-safety";

const summarySchema = z.object({
  summary: z.string().min(1).max(2000),
  action_items: z.array(z.string().min(1).max(300)).max(10),
});

const summaryJsonSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    action_items: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "action_items"],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You summarize the transcript of a voice message for the person who received it.

- summary: 1–3 sentences covering what the speaker said. Don't add anything that isn't in the transcript.
- action_items: concrete things the speaker asked for or committed to, as short imperative phrases. Empty if none.
- The transcript was produced by speech recognition and may contain errors; don't invent missing details.

${UNTRUSTED_DATA_RULES}

Respond with a single JSON object: {"summary": string, "action_items": string[]}.`;

const TRANSCRIPTION_FAILED = "Transcription failed. Please try again.";
const SUMMARY_FAILED = "Summary failed. Please try again.";

/**
 * Voice Intelligence: transcription, then (on request) a summary and
 * action items. Access reuses the Phase 3 media rules (MediaService) —
 * the same check that gates downloading the audio. Audio is only sent to
 * the transcription provider after the user has turned Voice Intelligence
 * on and explicitly asked for this voice message.
 *
 * States: transcribing → complete (transcript) → processing → complete
 * (summary), or failed. Requests are synchronous; the stored state plus
 * the gateway's `ai:*` events let other tabs/devices follow along.
 */
export class VoiceIntelligenceService {
  constructor(
    private readonly settings: AISettingsService,
    private readonly repository: AIRepository,
    private readonly mediaService: MediaService,
    private readonly gateway: AIGateway,
    private readonly maxAudioBytes: number
  ) {}

  private async requireAudio(userId: string, attachmentId: string): Promise<AttachmentDTO> {
    const attachment = await this.mediaService.getMetadata(attachmentId, userId);
    if (attachment.kind !== "audio") throw new AppError("Only audio attachments can be transcribed", 400);
    if (attachment.conversationId && (await this.repository.listExclusions(userId)).includes(attachment.conversationId)) {
      throw new AppError("This conversation is excluded from AI in your settings", 400, true, "ai_conversation_excluded");
    }
    return attachment;
  }

  async get(userId: string, attachmentId: string): Promise<VoiceResultDTO | null> {
    await this.mediaService.getMetadata(attachmentId, userId);
    return this.repository.findVoiceResult(userId, attachmentId);
  }

  async transcribe(userId: string, attachmentId: string, languageHint?: string): Promise<VoiceResultDTO> {
    await this.settings.require(userId, "voice");
    const attachment = await this.requireAudio(userId, attachmentId);
    if (attachment.sizeBytes > this.maxAudioBytes) {
      throw new AppError("This voice message is too large to transcribe", 413);
    }

    const { data } = await this.mediaService.getContent(attachmentId, userId);
    await this.repository.saveVoiceResult(userId, attachmentId, { status: "transcribing", summary: null, actionItems: [] });
    try {
      const result = await this.gateway.transcribe(userId, {
        audio: data,
        mimeType: attachment.mimeType,
        filename: attachment.originalFilename,
        languageHint,
      });
      if (!result.text) {
        return this.repository.saveVoiceResult(userId, attachmentId, {
          status: "failed",
          transcript: null,
          errorMessage: "No speech was recognized in this voice message.",
        });
      }
      return this.repository.saveVoiceResult(userId, attachmentId, {
        status: "complete",
        transcript: result.text.slice(0, 50_000),
        detectedLanguage: result.detectedLanguage?.slice(0, 16) ?? null,
      });
    } catch (err) {
      await this.repository.saveVoiceResult(userId, attachmentId, { status: "failed", errorMessage: TRANSCRIPTION_FAILED });
      throw err;
    }
  }

  async analyze(userId: string, attachmentId: string): Promise<VoiceResultDTO> {
    await this.settings.require(userId, "provider");
    await this.requireAudio(userId, attachmentId);
    const existing = await this.repository.findVoiceResult(userId, attachmentId);
    if (!existing?.transcript) throw new AppError("Transcribe this voice message first", 409);

    await this.repository.saveVoiceResult(userId, attachmentId, { status: "processing" });
    try {
      const { data } = await this.gateway.generateStructured(userId, "voice_summary", {
        system: SYSTEM_PROMPT,
        input: `Voice message transcript:\n${renderSingleMessage(existing.transcript.slice(0, 20_000))}`,
        maxOutputTokens: 2000,
        schema: summarySchema,
        jsonSchema: summaryJsonSchema,
      });
      return this.repository.saveVoiceResult(userId, attachmentId, {
        status: "complete",
        summary: data.summary.trim(),
        actionItems: data.action_items.map((item) => item.trim()),
      });
    } catch (err) {
      // The transcript is kept; only the summary step failed.
      await this.repository.saveVoiceResult(userId, attachmentId, { status: "failed", errorMessage: SUMMARY_FAILED });
      throw err;
    }
  }
}
