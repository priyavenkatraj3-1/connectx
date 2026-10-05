import type { EnvConfig } from "../../../config/env";
import { CloudinaryStorageProvider, createCloudinaryClient, parseCloudinaryUrl } from "./cloudinary.storage";
import { LocalDiskStorageProvider } from "./local-disk.storage";
import type { StorageProvider } from "./storage-provider.interface";

/**
 * Picks the media storage backend from configuration (MEDIA_STORAGE):
 * local disk for development, Cloudinary for production hosts without a
 * persistent disk. Fails fast on a missing or malformed CLOUDINARY_URL.
 */
export function createStorageProvider(config: Pick<EnvConfig, "mediaStorage" | "uploadDir" | "cloudinary">): StorageProvider {
  if (config.mediaStorage === "cloudinary") {
    if (!config.cloudinary.url) throw new Error("MEDIA_STORAGE=cloudinary requires CLOUDINARY_URL");
    const client = createCloudinaryClient(parseCloudinaryUrl(config.cloudinary.url));
    return new CloudinaryStorageProvider(client, config.cloudinary.folder);
  }
  return new LocalDiskStorageProvider(config.uploadDir);
}
