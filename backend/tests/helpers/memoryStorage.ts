import { assertValidStorageKey, type StorageProvider } from "../../src/modules/media/storage/storage-provider.interface";

/** In-memory StorageProvider so media tests don't touch the filesystem. */
export class MemoryStorageProvider implements StorageProvider {
  readonly files = new Map<string, Buffer>();

  async save(storageKey: string, data: Buffer): Promise<void> {
    assertValidStorageKey(storageKey);
    this.files.set(storageKey, Buffer.from(data));
  }

  async read(storageKey: string): Promise<Buffer> {
    const data = this.files.get(storageKey);
    if (!data) throw new Error("not found");
    return data;
  }

  async delete(storageKey: string): Promise<void> {
    this.files.delete(storageKey);
  }
}
