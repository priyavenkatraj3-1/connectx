/**
 * Client-side storage abstraction for the offline foundation (Phase 6).
 *
 * Everything offline-related goes through `KeyValueStore`, so the backing
 * store can later be swapped for IndexedDB (async, larger quota) without
 * touching the outbox or cache logic. The interface is async for exactly
 * that reason, even though the current localStorage implementation isn't.
 *
 * Isolation: every key is namespaced by user ID (`connectx.offline.<userId>.`),
 * so one account can never read another's cached data; signing in purges
 * other accounts' offline data, and signing out clears your own.
 *
 * Security note: localStorage is not encrypted at rest. Only recent message
 * text, conversation summaries and not-yet-sent drafts are stored — never
 * tokens (those live in AuthContext's own key), attachments, or AI data.
 */
export interface KeyValueStore {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

const ROOT = "connectx.offline.";

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** localStorage-backed store under a prefix. Quota/serialization failures are swallowed — offline data is best-effort. */
export class LocalStorageStore implements KeyValueStore {
  constructor(private readonly prefix: string) {}

  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = safeLocalStorage()?.getItem(this.prefix + key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    try {
      safeLocalStorage()?.setItem(this.prefix + key, JSON.stringify(value));
    } catch {
      // Quota exceeded or storage disabled: the app keeps working online.
    }
  }

  async remove(key: string): Promise<void> {
    safeLocalStorage()?.removeItem(this.prefix + key);
  }

  async keys(): Promise<string[]> {
    const storage = safeLocalStorage();
    if (!storage) return [];
    const result: string[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key?.startsWith(this.prefix)) result.push(key.slice(this.prefix.length));
    }
    return result;
  }
}

/** In-memory store — for tests, or when persistence is switched off. */
export class MemoryStore implements KeyValueStore {
  private readonly data = new Map<string, string>();
  async get<T>(key: string): Promise<T | null> {
    const raw = this.data.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  }
  async set<T>(key: string, value: T): Promise<void> {
    this.data.set(key, JSON.stringify(value));
  }
  async remove(key: string): Promise<void> {
    this.data.delete(key);
  }
  async keys(): Promise<string[]> {
    return [...this.data.keys()];
  }
}

export function userNamespace(userId: string): string {
  return `${ROOT}${userId}.`;
}

/** The store for one signed-in user. */
export function storeForUser(userId: string): KeyValueStore {
  return new LocalStorageStore(userNamespace(userId));
}

function removeMatching(predicate: (key: string) => boolean): void {
  const storage = safeLocalStorage();
  if (!storage) return;
  const doomed: string[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key && key.startsWith(ROOT) && predicate(key)) doomed.push(key);
  }
  for (const key of doomed) storage.removeItem(key);
}

/** Removes all offline data of one user (on sign-out). */
export function clearOfflineDataFor(userId: string): void {
  const prefix = userNamespace(userId);
  removeMatching((key) => key.startsWith(prefix));
}

/** Removes offline data of every user except `userId` (on sign-in), so a shared browser never mixes accounts. */
export function purgeOfflineDataExcept(userId: string): void {
  const keep = userNamespace(userId);
  removeMatching((key) => !key.startsWith(keep));
}
