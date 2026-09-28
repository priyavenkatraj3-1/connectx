import { AppError } from "../../../middleware/errorHandler";
import type { MessagesRepository } from "../../messages/messages.repository";
import type { AISettingsService } from "../ai-settings.service";
import type { AIRepository } from "../ai.repository";
import type { AIMemoryDTO, MemoryType } from "../ai.types";

export const MAX_MEMORIES_PER_USER = 200;

/**
 * Explicit, user-controlled AI memory. Items are only ever created by the
 * user (typed, or "remember this message"); no conversation content is
 * turned into memory automatically. Viewing, deleting and clearing always
 * work — even with memory switched off — so a user can always remove what
 * was stored. Memory is only *used* (Ask Your Chats) while it is enabled.
 */
export class AIMemoryService {
  constructor(
    private readonly settings: AISettingsService,
    private readonly repository: AIRepository,
    private readonly messagesRepository: MessagesRepository
  ) {}

  async list(userId: string): Promise<{ enabled: boolean; items: AIMemoryDTO[] }> {
    const settings = await this.settings.getSettings(userId);
    return { enabled: settings.aiMemoryEnabled, items: await this.repository.listMemories(userId) };
  }

  async create(userId: string, input: { type: MemoryType; content: string; sourceMessageId?: string }): Promise<AIMemoryDTO> {
    await this.settings.require(userId, "memory_write");
    if ((await this.repository.countMemories(userId)) >= MAX_MEMORIES_PER_USER) {
      throw new AppError(`You can keep at most ${MAX_MEMORIES_PER_USER} memories. Delete some first.`, 409);
    }

    let sourceConversationId: string | null = null;
    if (input.sourceMessageId) {
      const message = await this.messagesRepository.findRecordById(input.sourceMessageId);
      // Same 404 whether it doesn't exist or isn't visible — never confirm another chat's message exists.
      if (!message || !(await this.messagesRepository.isVisibleTo(message.id, userId))) {
        throw new AppError("Message not found", 404);
      }
      sourceConversationId = message.conversationId;
    }

    return this.repository.createMemory({
      userId,
      type: input.type,
      content: input.content,
      sourceConversationId,
      sourceMessageId: input.sourceMessageId ?? null,
    });
  }

  async remove(userId: string, memoryId: string): Promise<void> {
    if (!(await this.repository.deleteMemory(userId, memoryId))) throw new AppError("Memory not found", 404);
  }

  async clear(userId: string): Promise<number> {
    return this.repository.clearMemories(userId);
  }
}
