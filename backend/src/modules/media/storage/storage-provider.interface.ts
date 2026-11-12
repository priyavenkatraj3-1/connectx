/**
 * Where attachment bytes live. Metadata always lives in PostgreSQL
 * (`attachments`); this interface only moves opaque bytes keyed by a
 * server-generated storage key.
 *
 * Phase 3 ships LocalDiskStorageProvider for development. An S3/object
 * storage implementation can be dropped in later without touching the
 * media service, repository or routes.
 */
export interface StorageProvider {
  save(storageKey: string, data: Buffer): Promise<void>;
  read(storageKey: string): Promise<Buffer>;
  /** Deleting a key that does not exist is not an error. */
  delete(storageKey: string): Promise<void>;
}

/**
 * Storage keys are server-generated, never user-controlled:
 *   message attachments: "<conversationId>/<attachmentId>"
 *   status media:        "statuses/<ownerId>/<attachmentId>"
 *   profile pictures:    "avatars/<userId>/<avatarId>"
 */
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const STORAGE_KEY_PATTERN = new RegExp(`^(statuses/|avatars/)?${UUID}/${UUID}$`);

export function buildStorageKey(conversationId: string, attachmentId: string): string {
  const key = `${conversationId}/${attachmentId}`.toLowerCase();
  assertValidStorageKey(key);
  return key;
}

export function buildStatusStorageKey(ownerId: string, attachmentId: string): string {
  const key = `statuses/${ownerId}/${attachmentId}`.toLowerCase();
  assertValidStorageKey(key);
  return key;
}

export function buildAvatarStorageKey(userId: string, avatarId: string): string {
  const key = `avatars/${userId}/${avatarId}`.toLowerCase();
  assertValidStorageKey(key);
  return key;
}

export function assertValidStorageKey(storageKey: string): void {
  if (!STORAGE_KEY_PATTERN.test(storageKey)) {
    throw new Error(`Invalid storage key: ${JSON.stringify(storageKey)}`);
  }
}
