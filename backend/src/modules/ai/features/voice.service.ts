import { z } from "zod";
import { AppError } from "../../../middleware/errorHandler";
import type { MediaService } from "../../media/media.service";
import type { AttachmentDTO } from "../../media/media.types";
import type { AISettingsService } from "../ai-settings.service";
import type { AIGateway } from "../ai.gateway";
import type { AIRepository, VoiceTranslationRecord } from "../ai.repository";
import type { VoiceResultDTO, VoiceTranslationDTO } from "../ai.types";
import { renderSingleMessage, UNTRUSTED_DATA_RULES } from "../context/prompt-safety";
import { isVoiceTranslationLanguage } from "../languages";
import { hashText, type TranslationService } from "./translation.service";

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
export const NO_SPEECH = "No speech was recognized in this voice message.";
export const INTERRUPTED = "Transcription was interrupted. Please try again.";

/**
 * Audio types (as validated at upload, from the bytes) that Whisper-style
 * transcription APIs accept, with the file extension they expect. Those
 * services usually infer the format from the file name, so the provider
 * gets a neutral name with the right extension — never the user's own
 * file name. Anything else is refused before any audio leaves the server.
 */
const TRANSCRIBABLE_EXTENSIONS: Readonly<Record<string, string>> = {
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/webm": "webm",
};

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
 *
 * Concurrent requests for the same voice message by the same user (two
 * tabs, a double click) share one provider call; the in-flight set lives
 * in this process, like the rest of the realtime state (single instance).
 */
export class VoiceIntelligenceService {
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly settings: AISettingsService,
    private readonly repository: AIRepository,
    private readonly mediaService: MediaService,
    private readonly gateway: AIGateway,
    private readonly maxAudioBytes: number,
    private readonly translation: TranslationService
  ) {}

  private async requireAudio(userId: string, attachmentId: string): Promise<AttachmentDTO> {
    const attachment = await this.mediaService.getMetadata(attachmentId, userId);
    if (attachment.kind !== "audio") throw new AppError("Only audio attachments can be transcribed", 400);
    if (attachment.conversationId && (await this.repository.listExclusions(userId)).includes(attachment.conversationId)) {
      throw new AppError("This conversation is excluded from AI in your settings", 400, true, "ai_conversation_excluded");
    }
    return attachment;
  }

  /** Joins an identical request already running for this user and voice message, or starts one. */
  private once<T>(key: string, work: () => Promise<T>): Promise<T> {
    const running = this.inFlight.get(key) as Promise<T> | undefined;
    if (running) return running;
    const started = work().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, started);
    return started;
  }

  async get(userId: string, attachmentId: string): Promise<VoiceResultDTO | null> {
    await this.mediaService.getMetadata(attachmentId, userId);
    const result = await this.repository.findVoiceResult(userId, attachmentId);
    // A request that was running when the server stopped will never finish: offer a retry instead of "working" forever.
    if (result?.status === "transcribing" && !this.inFlight.has(`transcribe:${userId}:${attachmentId}`)) {
      return { ...result, status: "failed", errorMessage: INTERRUPTED };
    }
    if (result?.status === "processing" && !this.inFlight.has(`analyze:${userId}:${attachmentId}`)) {
      return { ...result, status: "failed", errorMessage: SUMMARY_FAILED };
    }
    return result;
  }

  async transcribe(userId: string, attachmentId: string, languageHint?: string): Promise<VoiceResultDTO> {
    await this.settings.require(userId, "voice");
    const attachment = await this.requireAudio(userId, attachmentId);
    const extension = TRANSCRIBABLE_EXTENSIONS[attachment.mimeType];
    if (!extension) throw new AppError("This audio format can't be transcribed", 415);
    if (attachment.sizeBytes > Math.min(this.maxAudioBytes, this.gateway.transcriptionMaxAudioBytes ?? Infinity)) {
      throw new AppError("This voice message is too large to transcribe", 413);
    }

    return this.once(`transcribe:${userId}:${attachmentId}`, async () => {
      const { data } = await this.mediaService.getContent(attachmentId, userId);
      await this.repository.saveVoiceResult(userId, attachmentId, { status: "transcribing", summary: null, actionItems: [] });
      try {
        const result = await this.gateway.transcribe(userId, {
          audio: data,
          mimeType: attachment.mimeType,
          filename: `voice-message.${extension}`,
          languageHint,
        });
        const text = result.text.trim(); // whitespace-only output is "no speech", whatever the provider
        if (!text) {
          return this.repository.saveVoiceResult(userId, attachmentId, {
            status: "failed",
            transcript: null,
            errorMessage: NO_SPEECH,
          });
        }
        return this.repository.saveVoiceResult(userId, attachmentId, {
          status: "complete",
          transcript: text.slice(0, 50_000),
          detectedLanguage: result.detectedLanguage?.slice(0, 16) ?? null,
        });
      } catch (err) {
        await this.repository.saveVoiceResult(userId, attachmentId, { status: "failed", errorMessage: TRANSCRIPTION_FAILED });
        throw err;
      }
    });
  }

  async analyze(userId: string, attachmentId: string): Promise<VoiceResultDTO> {
    await this.settings.require(userId, "provider");
    await this.requireAudio(userId, attachmentId);
    const existing = await this.repository.findVoiceResult(userId, attachmentId);
    if (!existing?.transcript) throw new AppError("Transcribe this voice message first", 409);

    return this.once(`analyze:${userId}:${attachmentId}`, async () => {
      await this.repository.saveVoiceResult(userId, attachmentId, { status: "processing" });
      try {
        const { data } = await this.gateway.generateStructured(userId, "voice_summary", {
          system: SYSTEM_PROMPT,
          input: `Voice message transcript:\n${renderSingleMessage(existing.transcript!.slice(0, 20_000))}`,
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
    });
  }

  /**
   * Translates the requester's own transcript of a voice message into one
   * of VOICE_TRANSLATION_LANGUAGES. Only the transcript text goes to the
   * text provider, never the audio; the audio and the transcript are left
   * untouched. Gated like transcription (AI + Voice Intelligence consent),
   * plus the text provider, the attachment read check and chat exclusions.
   *
   * Results are stored per (user, attachment, language) with a hash of the
   * transcript translated: a repeat request is served from storage, and
   * re-transcribing invalidates it. Concurrent identical requests share one
   * provider call.
   */
  async translate(userId: string, attachmentId: string, targetLanguage: string): Promise<VoiceTranslationDTO> {
    if (!isVoiceTranslationLanguage(targetLanguage)) {
      throw new AppError("Voice messages can be translated into Tamil, English, Hindi, Telugu or Malayalam", 400);
    }
    await this.settings.require(userId, "voice_translation");
    await this.requireAudio(userId, attachmentId);

    return this.once(`translate:${userId}:${attachmentId}:${targetLanguage}`, async () => {
      const voice = await this.repository.findVoiceResult(userId, attachmentId);
      const voiceResultId = await this.repository.findVoiceResultId(userId, attachmentId);
      const transcript = voice?.transcript?.trim();
      if (!voice || !voiceResultId || !transcript) throw new AppError("Transcribe this voice message first", 409);

      const sourceHash = hashText(transcript);
      const stored = await this.repository.findVoiceTranslation(userId, attachmentId, targetLanguage);
      if (stored && stored.sourceHash === sourceHash) return toTranslationDTO(stored, true);

      const result = await this.translation.translateText(userId, "voice_translation", transcript.slice(0, 20_000), targetLanguage);
      const saved = await this.repository.saveVoiceTranslation({
        voiceResultId,
        userId,
        attachmentId,
        targetLanguage,
        sourceHash,
        translatedText: result.translatedText.slice(0, 50_000),
        detectedSourceLanguage: (result.detectedSourceLanguage ?? voice.detectedLanguage)?.slice(0, 16) ?? null,
        provider: result.provider.slice(0, 32),
        model: result.model.slice(0, 80),
      });
      return toTranslationDTO(saved, false);
    });
  }

  /**
   * The requester's stored translations that still match their current
   * transcript (stale ones, from before a re-transcription, are left out).
   * Reading sends nothing to any provider; access matches `get`.
   */
  async listTranslations(userId: string, attachmentId: string): Promise<VoiceTranslationDTO[]> {
    await this.mediaService.getMetadata(attachmentId, userId);
    const transcript = (await this.repository.findVoiceResult(userId, attachmentId))?.transcript?.trim();
    if (!transcript) return [];
    const sourceHash = hashText(transcript);
    return (await this.repository.listVoiceTranslations(userId, attachmentId))
      .filter((stored) => stored.sourceHash === sourceHash)
      .map((stored) => toTranslationDTO(stored, true));
  }
}

function toTranslationDTO(stored: VoiceTranslationRecord, cached: boolean): VoiceTranslationDTO {
  return {
    attachmentId: stored.attachmentId,
    targetLanguage: stored.targetLanguage,
    translatedText: stored.translatedText,
    detectedSourceLanguage: stored.detectedSourceLanguage,
    cached,
    // Cached results report no generator, matching message translation (nothing was generated for this request).
    generatedBy: !cached && stored.provider && stored.model ? { provider: stored.provider, model: stored.model } : null,
    updatedAt: stored.updatedAt,
  };
}
