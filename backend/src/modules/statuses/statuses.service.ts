import { AppError } from "../../middleware/errorHandler";
import { broadcast } from "../../realtime/broadcast";
import type { RealtimeGateway } from "../../realtime/gateway.interface";
import type { MediaRepository } from "../media/media.repository";
import type { StorageProvider } from "../media/storage/storage-provider.interface";
import type { UsersRepository } from "../users/users.repository";
import type { StatusesRepository, StatusRecord } from "./statuses.repository";
import {
  STATUS_LIFETIME_MS,
  type OwnStatusDTO,
  type StatusDTO,
  type StatusFeedEntry,
  type StatusListResponse,
  type StatusPrivacySettingsDTO,
  type StatusViewerDTO,
} from "./statuses.types";
import type { CreateStatusInput, StatusPrivacyInput } from "./statuses.validation";

function toStatusDTO(status: StatusRecord, viewedByMe: boolean): StatusDTO {
  return {
    id: status.id,
    userId: status.userId,
    type: status.type,
    text: status.text,
    backgroundColor: status.backgroundColor,
    media: status.media,
    createdAt: status.createdAt,
    expiresAt: status.expiresAt,
    viewedByMe,
  };
}

function toOwnStatusDTO(status: StatusRecord, viewCount: number): OwnStatusDTO {
  return {
    ...toStatusDTO(status, true),
    visibility: status.visibility,
    audienceUserIds: status.audienceUserIds,
    viewCount,
  };
}

/**
 * Status / stories. Every privacy decision is made here and in
 * StatusesRepository — the frontend only displays what the API returned.
 * Invisible, expired and nonexistent statuses all produce the same 404, so
 * the API never confirms that a status you may not see exists.
 */
export class StatusesService {
  constructor(
    private readonly statusesRepository: StatusesRepository,
    private readonly mediaRepository: MediaRepository,
    private readonly usersRepository: UsersRepository,
    private readonly storage: StorageProvider,
    private readonly realtimeGateway: RealtimeGateway,
    private readonly now: () => Date = () => new Date()
  ) {}

  async create(ownerId: string, input: CreateStatusInput): Promise<OwnStatusDTO> {
    let attachmentId: string | null = null;
    if (input.type !== "text") {
      const attachment = await this.mediaRepository.findById(input.attachmentId!);
      // Uniform 404 for "doesn't exist" and "isn't yours" — don't reveal other users' uploads.
      if (!attachment || attachment.uploaderId !== ownerId) throw new AppError("Attachment not found", 404);
      if (attachment.purpose !== "status") {
        throw new AppError("Upload status media with purpose=status", 400);
      }
      if (attachment.kind !== input.type) {
        throw new AppError(`That upload is a ${attachment.kind}, not a ${input.type}`, 400);
      }
      if (await this.statusesRepository.findStatusIdByAttachment(attachment.id)) {
        throw new AppError("That upload is already used by another status", 409);
      }
      attachmentId = attachment.id;
    }

    const privacy = input.privacy
      ? await this.normalizePrivacy(ownerId, input.privacy)
      : await this.statusesRepository.getPrivacySettings(ownerId);
    if (privacy.visibility === "selected" && privacy.userIds.length === 0) {
      throw new AppError("Choose at least one person to share this status with", 400);
    }

    const createdAt = this.now();
    let status: StatusRecord;
    try {
      status = await this.statusesRepository.create({
        ownerId,
        type: input.type,
        text: input.text ? input.text : null,
        backgroundColor: input.type === "text" ? (input.backgroundColor ?? "indigo") : null,
        attachmentId,
        visibility: privacy.visibility,
        audienceUserIds: privacy.visibility === "selected" || privacy.visibility === "except" ? privacy.userIds : [],
        // Expiry is decided here, on the server — never taken from the client.
        expiresAt: new Date(createdAt.getTime() + STATUS_LIFETIME_MS),
      });
    } catch (err) {
      // Lost a race with another status claiming the same upload (statuses.attachment_id is UNIQUE).
      if (attachmentId && (await this.statusesRepository.findStatusIdByAttachment(attachmentId))) {
        throw new AppError("That upload is already used by another status", 409);
      }
      throw err;
    }

    const audience = await this.statusesRepository.audienceOf(status);
    broadcast(this.realtimeGateway, [ownerId, ...audience], { type: "status:created", statusId: status.id, userId: ownerId });
    return toOwnStatusDTO(status, 0);
  }

  /** Your own active statuses, plus every active status from other people that you're allowed to see, grouped by person. */
  async list(viewerId: string): Promise<StatusListResponse> {
    const mine = await this.statusesRepository.listActiveByOwners([viewerId]);
    const counts = await this.statusesRepository.viewCounts(mine.map((s) => s.id));

    const candidateOwners = new Set([
      ...(await this.statusesRepository.conversationPeerIds(viewerId)),
      ...(await this.statusesRepository.findOwnersSelectingViewer(viewerId)),
    ]);
    candidateOwners.delete(viewerId);

    const candidates = await this.statusesRepository.listActiveByOwners([...candidateOwners]);
    const contactsCache = new Map<string, Set<string>>();
    const visible: StatusRecord[] = [];
    for (const status of candidates) {
      if (await this.statusesRepository.canView(status, viewerId, contactsCache)) visible.push(status);
    }

    const viewed = await this.statusesRepository.viewedBy(
      visible.map((s) => s.id),
      viewerId
    );
    const profiles = await this.usersRepository.findManyPublicProfiles([...new Set(visible.map((s) => s.userId))]);

    const byOwner = new Map<string, StatusDTO[]>();
    for (const status of visible) {
      if (!profiles.has(status.userId)) continue; // deactivated user
      const list = byOwner.get(status.userId) ?? [];
      list.push(toStatusDTO(status, viewed.has(status.id)));
      byOwner.set(status.userId, list);
    }

    const feed: StatusFeedEntry[] = [...byOwner.entries()].map(([ownerId, statuses]) => ({
      user: profiles.get(ownerId)!,
      statuses,
      hasUnseen: statuses.some((s) => !s.viewedByMe),
      latestAt: statuses[statuses.length - 1]!.createdAt,
    }));
    // Unseen first, then most recent first — the usual stories ordering.
    feed.sort(
      (a, b) => Number(b.hasUnseen) - Number(a.hasUnseen) || new Date(b.latestAt).getTime() - new Date(a.latestAt).getTime()
    );

    return { mine: mine.map((s) => toOwnStatusDTO(s, counts.get(s.id) ?? 0)), feed };
  }

  async get(statusId: string, viewerId: string): Promise<StatusDTO | OwnStatusDTO> {
    const status = await this.requireVisible(statusId, viewerId);
    if (status.userId === viewerId) {
      const counts = await this.statusesRepository.viewCounts([status.id]);
      return toOwnStatusDTO(status, counts.get(status.id) ?? 0);
    }
    const viewed = await this.statusesRepository.viewedBy([status.id], viewerId);
    return toStatusDTO(status, viewed.has(status.id));
  }

  /** Records that the viewer saw the status (once). Viewing your own status records nothing. */
  async markViewed(statusId: string, viewerId: string): Promise<{ viewedAt: Date | null }> {
    const status = await this.requireVisible(statusId, viewerId);
    if (status.userId === viewerId) return { viewedAt: null };

    const isFirstView = await this.statusesRepository.recordView(statusId, viewerId);
    if (isFirstView) {
      const [viewer, counts, viewers] = await Promise.all([
        this.usersRepository.findPublicProfile(viewerId),
        this.statusesRepository.viewCounts([statusId]),
        this.statusesRepository.listViewers(statusId),
      ]);
      const viewedAt = viewers.find((v) => v.userId === viewerId)?.viewedAt ?? this.now();
      if (viewer) {
        this.realtimeGateway.sendToUser(status.userId, {
          type: "status:viewed",
          statusId,
          viewer: { userId: viewer.id, displayName: viewer.displayName, avatarUrl: viewer.avatarUrl },
          viewedAt,
          viewCount: counts.get(statusId) ?? 0,
        });
      }
      return { viewedAt };
    }
    const existing = (await this.statusesRepository.listViewers(statusId)).find((v) => v.userId === viewerId);
    return { viewedAt: existing?.viewedAt ?? null };
  }

  /** Only the owner may see who viewed a status. */
  async listViewers(statusId: string, requesterId: string): Promise<StatusViewerDTO[]> {
    const status = await this.requireVisible(statusId, requesterId);
    if (status.userId !== requesterId) {
      throw new AppError("Only the owner can see who viewed a status", 403);
    }
    return this.statusesRepository.listViewers(statusId);
  }

  async delete(statusId: string, requesterId: string): Promise<void> {
    const status = await this.statusesRepository.findById(statusId);
    if (!status) throw new AppError("Status not found", 404);
    if (status.userId !== requesterId) {
      // A status you can't see "doesn't exist"; one you can see but don't own is forbidden.
      if (!(await this.statusesRepository.isVisibleTo(statusId, requesterId))) throw new AppError("Status not found", 404);
      throw new AppError("You can only delete your own statuses", 403);
    }

    const audience = await this.statusesRepository.audienceOf(status);
    await this.statusesRepository.delete(status);
    if (status.storageKey) await this.storage.delete(status.storageKey).catch(() => undefined);

    broadcast(this.realtimeGateway, [requesterId, ...audience], { type: "status:deleted", statusId, userId: requesterId });
  }

  async getPrivacySettings(ownerId: string): Promise<StatusPrivacySettingsDTO> {
    return this.statusesRepository.getPrivacySettings(ownerId);
  }

  async updatePrivacySettings(ownerId: string, input: StatusPrivacyInput): Promise<StatusPrivacySettingsDTO> {
    const settings = await this.normalizePrivacy(ownerId, input);
    await this.statusesRepository.savePrivacySettings(ownerId, settings);
    return this.statusesRepository.getPrivacySettings(ownerId);
  }

  /**
   * Removes expired statuses: tells their audience (so open clients drop
   * them), then deletes the rows and media bytes. Expired statuses are
   * already invisible to every query before this runs; the sweep is
   * cleanup + notification, not the source of truth for expiry.
   */
  async sweepExpired(): Promise<number> {
    const expired = await this.statusesRepository.listExpired();
    const byOwner = new Map<string, { ids: string[]; audience: Set<string> }>();

    for (const status of expired) {
      const entry = byOwner.get(status.userId) ?? { ids: [], audience: new Set<string>([status.userId]) };
      entry.ids.push(status.id);
      for (const userId of await this.statusesRepository.audienceOf(status)) entry.audience.add(userId);
      byOwner.set(status.userId, entry);

      await this.statusesRepository.delete(status);
      if (status.storageKey) await this.storage.delete(status.storageKey).catch(() => undefined);
    }

    for (const [ownerId, { ids, audience }] of byOwner) {
      broadcast(this.realtimeGateway, audience, { type: "status:expired", statusIds: ids, userId: ownerId });
    }
    return expired.length;
  }

  private async requireVisible(statusId: string, viewerId: string): Promise<StatusRecord> {
    if (!(await this.statusesRepository.isVisibleTo(statusId, viewerId))) {
      throw new AppError("Status not found", 404);
    }
    return (await this.statusesRepository.findById(statusId))!;
  }

  /** De-duplicates the user list, drops the owner, and checks every user exists. */
  private async normalizePrivacy(ownerId: string, input: StatusPrivacyInput): Promise<StatusPrivacySettingsDTO> {
    const userIds = [...new Set(input.userIds ?? [])].filter((id) => id !== ownerId);
    if (userIds.length > 0) {
      const profiles = await this.usersRepository.findManyPublicProfiles(userIds);
      const unknown = userIds.filter((id) => !profiles.has(id));
      if (unknown.length > 0) throw new AppError(`Unknown or inactive users: ${unknown.join(", ")}`, 400);
    }
    const usesList = input.visibility === "selected" || input.visibility === "except";
    return { visibility: input.visibility, userIds: usesList ? userIds : [] };
  }
}
