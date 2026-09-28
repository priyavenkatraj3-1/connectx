import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { dirname, resolve, sep } from "path";
import { assertValidStorageKey, type StorageProvider } from "./storage-provider.interface";

/**
 * Development storage: writes attachment bytes under a local directory
 * (UPLOAD_DIR, default backend/uploads — gitignored). Not suitable for
 * multi-instance production deployments; swap in an object-storage
 * provider for that.
 *
 * Path traversal is prevented twice: keys must match the strict
 * "<uuid>/<uuid>" pattern, and the resolved path must stay inside the
 * root directory.
 */
export class LocalDiskStorageProvider implements StorageProvider {
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = resolve(rootDir);
  }

  private pathFor(storageKey: string): string {
    assertValidStorageKey(storageKey);
    const fullPath = resolve(this.root, storageKey);
    if (!fullPath.startsWith(this.root + sep)) {
      throw new Error("Storage key resolves outside the storage root");
    }
    return fullPath;
  }

  async save(storageKey: string, data: Buffer): Promise<void> {
    const fullPath = this.pathFor(storageKey);
    await mkdir(dirname(fullPath), { recursive: true });
    // `wx` fails if the file already exists — keys are unique, so a collision means something is wrong.
    await writeFile(fullPath, data, { flag: "wx" });
  }

  async read(storageKey: string): Promise<Buffer> {
    return readFile(this.pathFor(storageKey));
  }

  async delete(storageKey: string): Promise<void> {
    await rm(this.pathFor(storageKey), { force: true });
  }
}
