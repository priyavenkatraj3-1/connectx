import { AppError } from "../../middleware/errorHandler";
import { broadcast } from "../../realtime/broadcast";
import type { RealtimeGateway } from "../../realtime/gateway.interface";
import { generateId } from "../../utils/id";
import { logger } from "../../utils/logger";
import { FILE_TYPE_RULES } from "../media/file-validation";
import { buildAvatarStorageKey, type StorageProvider } from "../media/storage/storage-provider.interface";
import type { UsersRepository } from "./users.repository";
import type { ContactProfile, OwnProfile, ProfileUpdateInput, PublicProfile } from "./users.types";

/** Largest profile picture accepted. The web client uploads a 512px JPEG (well under 1MB). */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
/** Raster formats only (no SVG, no animation-only formats), recognized by their bytes — never by a name or header. */
const AVATAR_TYPES = [
  { extension: "jpg", mimeType: "image/jpeg" },
  { extension: "png", mimeType: "image/png" },
  { extension: "webp", mimeType: "image/webp" },
] as const;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** The avatar_url the server writes for an uploaded picture. Clients can't set this form (PATCH accepts http(s) URLs only). */
export function avatarPath(userId: string, avatarId: string): string {
  return `/api/v1/users/${userId}/avatar/${avatarId}`;
}
/** The avatar ID if `avatarUrl` is this user's own uploaded picture, else null (an external URL, or nothing). */
function uploadedAvatarId(userId: string, avatarUrl: string | null): string | null {
  const match = avatarUrl ? new RegExp(`^/api/v1/users/${userId}/avatar/(${UUID})$`, "i").exec(avatarUrl) : null;
  return match ? match[1]!.toLowerCase() : null;
}

export function detectAvatarType(data: Buffer): (typeof AVATAR_TYPES)[number] | null {
  return AVATAR_TYPES.find((type) => FILE_TYPE_RULES[type.extension]!.matches(data)) ?? null;
}

export class UsersService {
  constructor(
    private readonly usersRepository: UsersRepository,
    /** Where profile pictures are stored (same provider and conventions as chat media). */
    private readonly storage?: StorageProvider,
    private readonly realtimeGateway?: RealtimeGateway
  ) {}

  async getOwnProfile(userId: string): Promise<OwnProfile> {
    const profile = await this.usersRepository.findOwnProfile(userId);
    if (!profile) {
      throw new AppError("User not found", 404);
    }
    return profile;
  }

  async getPublicProfile(userId: string): Promise<PublicProfile> {
    const profile = await this.usersRepository.findPublicProfile(userId);
    if (!profile) {
      throw new AppError("User not found", 404);
    }
    return profile;
  }

  /** Another user's profile as shown in a chat's contact info: the bio only if you share a conversation. */
  async getContactProfile(userId: string, requesterId: string): Promise<ContactProfile> {
    const profile = await this.usersRepository.findContactProfile(userId);
    if (!profile) {
      throw new AppError("User not found", 404);
    }
    const { bio, ...publicProfile } = profile;
    const mayViewBio = userId === requesterId || (await this.usersRepository.shareActiveConversation(requesterId, userId));
    return mayViewBio ? { ...publicProfile, bio } : publicProfile;
  }

  async updateOwnProfile(userId: string, updates: ProfileUpdateInput): Promise<OwnProfile> {
    const before = updates.avatarUrl !== undefined ? await this.usersRepository.findOwnProfile(userId) : null;
    const updated = await this.usersRepository.updateProfile(userId, updates);
    // Switching to an external URL (or none) leaves the previously uploaded picture unused: remove its bytes.
    if (before && before.avatarUrl !== updated.avatarUrl) await this.deleteUploadedAvatar(userId, before.avatarUrl);
    if (updates.displayName !== undefined || updates.avatarUrl !== undefined || updates.statusMessage !== undefined) {
      await this.announceProfileChange(updated);
    }
    return updated;
  }

  /**
   * Replaces the signed-in user's profile picture with an uploaded image.
   * The user always comes from the access token, so nobody can change
   * someone else's picture. The type is decided from the bytes (JPEG, PNG
   * or WebP); the storage key and URL are generated here.
   */
  async setAvatar(userId: string, data: Buffer): Promise<OwnProfile> {
    if (!this.storage) throw new AppError("Profile pictures aren't available", 503);
    if (data.length === 0) throw new AppError("The image is empty", 400);
    if (data.length > AVATAR_MAX_BYTES) throw new AppError(`Profile pictures can be at most ${AVATAR_MAX_BYTES / (1024 * 1024)}MB`, 413);
    if (!detectAvatarType(data)) throw new AppError("Profile pictures must be JPEG, PNG or WebP images", 415);

    const before = await this.usersRepository.findOwnProfile(userId);
    if (!before) throw new AppError("User not found", 404);
    const avatarId = generateId();
    await this.storage.save(buildAvatarStorageKey(userId, avatarId), data);
    const updated = await this.usersRepository.updateProfile(userId, { avatarUrl: avatarPath(userId, avatarId) });
    await this.deleteUploadedAvatar(userId, before.avatarUrl);
    await this.announceProfileChange(updated);
    return updated;
  }

  /** Removes the signed-in user's profile picture (uploaded or external). */
  async removeAvatar(userId: string): Promise<OwnProfile> {
    return this.updateOwnProfile(userId, { avatarUrl: null });
  }

  /**
   * The bytes of a user's *current* uploaded picture. Anything else — a
   * replaced or removed picture, another user's ID, an unknown user — is the
   * same 404, so old pictures stop being served once replaced.
   */
  async readAvatar(userId: string, avatarId: string): Promise<{ data: Buffer; mimeType: string }> {
    const profile = await this.usersRepository.findPublicProfile(userId);
    if (!this.storage || !profile || uploadedAvatarId(userId, profile.avatarUrl) !== avatarId.toLowerCase()) {
      throw new AppError("Not found", 404);
    }
    let data: Buffer;
    try {
      data = await this.storage.read(buildAvatarStorageKey(userId, avatarId));
    } catch {
      throw new AppError("Not found", 404);
    }
    const type = detectAvatarType(data);
    if (!type) throw new AppError("Not found", 404);
    return { data, mimeType: type.mimeType };
  }

  private async deleteUploadedAvatar(userId: string, avatarUrl: string | null): Promise<void> {
    const avatarId = uploadedAvatarId(userId, avatarUrl);
    if (!avatarId || !this.storage) return;
    // Best effort: the old picture is already unreachable (readAvatar only serves the current one).
    await this.storage.delete(buildAvatarStorageKey(userId, avatarId)).catch((err) => logger.warn("[avatars] couldn't delete an old picture", err));
  }

  /** Your devices and everyone who shares a chat with you see the new name/picture without reloading. */
  private async announceProfileChange(profile: OwnProfile): Promise<void> {
    if (!this.realtimeGateway) return;
    const user: PublicProfile = { id: profile.id, displayName: profile.displayName, avatarUrl: profile.avatarUrl, statusMessage: profile.statusMessage };
    const contacts = await this.usersRepository.contactIds(profile.id);
    broadcast(this.realtimeGateway, [profile.id, ...contacts], { type: "user:updated", user });
  }

  async search(query: string, requestingUserId: string): Promise<PublicProfile[]> {
    return this.usersRepository.search(query, requestingUserId);
  }
}
