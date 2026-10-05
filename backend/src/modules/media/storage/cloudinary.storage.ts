import { v2 as cloudinarySdk, type UploadApiOptions } from "cloudinary";
import { assertValidStorageKey, type StorageProvider } from "./storage-provider.interface";

/** How long a read may take before it's reported as unavailable. */
const READ_TIMEOUT_MS = 30_000;

/**
 * Every asset is stored as `raw` + `authenticated`:
 * - raw: Cloudinary keeps the exact bytes (no image/video processing), so
 *   reads return what was uploaded, same as local disk.
 * - authenticated: there is no public URL. Only a URL signed with the API
 *   secret is delivered, and that URL is built and fetched by the backend
 *   only — clients still go through the authenticated
 *   GET /media/:id/content route, which enforces access.
 */
const RESOURCE_TYPE = "raw" as const;
const DELIVERY_TYPE = "authenticated" as const;

export interface CloudinaryCredentials {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
}

/**
 * Parses CLOUDINARY_URL (cloudinary://<api_key>:<api_secret>@<cloud_name>).
 * Error messages never include the URL itself: it carries the API secret.
 */
export function parseCloudinaryUrl(value: string): CloudinaryCredentials {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("CLOUDINARY_URL is not a valid URL (expected cloudinary://<api_key>:<api_secret>@<cloud_name>)");
  }
  const credentials = {
    cloudName: url.hostname,
    apiKey: decodeURIComponent(url.username),
    apiSecret: decodeURIComponent(url.password),
  };
  if (url.protocol !== "cloudinary:" || !credentials.cloudName || !credentials.apiKey || !credentials.apiSecret) {
    throw new Error("CLOUDINARY_URL must look like cloudinary://<api_key>:<api_secret>@<cloud_name>");
  }
  return credentials;
}

/**
 * The slice of the Cloudinary SDK this provider uses. Injectable so tests
 * run without credentials or network access.
 */
export interface CloudinaryClient {
  upload(data: Buffer, options: UploadApiOptions): Promise<{ existing?: boolean }>;
  destroy(publicId: string, options: { resource_type: string; type: string; invalidate: boolean }): Promise<{ result?: string }>;
  /** Builds a delivery URL locally (no network call). */
  url(publicId: string, options: { resource_type: string; type: string; sign_url: boolean; secure: boolean }): string;
}

/** Wraps the official SDK (cloudinary.v2) in the CloudinaryClient shape. */
export function createCloudinaryClient(credentials: CloudinaryCredentials): CloudinaryClient {
  cloudinarySdk.config({
    cloud_name: credentials.cloudName,
    api_key: credentials.apiKey,
    api_secret: credentials.apiSecret,
    secure: true,
  });

  return {
    upload: (data, options) =>
      new Promise((resolve, reject) => {
        const stream = cloudinarySdk.uploader.upload_stream(options, (err, result) => {
          if (err || !result) {
            reject(new Error(`Cloudinary upload failed${err ? ` (HTTP ${err.http_code}): ${err.message}` : ""}`));
            return;
          }
          resolve(result as { existing?: boolean });
        });
        stream.end(data);
      }),
    destroy: (publicId, options) => cloudinarySdk.uploader.destroy(publicId, options),
    url: (publicId, options) => cloudinarySdk.url(publicId, options),
  };
}

export type FetchLike = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

/**
 * Production media storage on Cloudinary. Storage keys are unchanged
 * ("<conversationId>/<attachmentId>", "statuses/<ownerId>/<attachmentId>");
 * each maps to the public ID "<folder>/<storageKey>".
 */
export class CloudinaryStorageProvider implements StorageProvider {
  constructor(
    private readonly client: CloudinaryClient,
    private readonly folder: string,
    private readonly fetchFn: FetchLike = fetch
  ) {}

  private publicIdFor(storageKey: string): string {
    assertValidStorageKey(storageKey);
    return `${this.folder}/${storageKey}`;
  }

  async save(storageKey: string, data: Buffer): Promise<void> {
    const result = await this.client.upload(data, {
      public_id: this.publicIdFor(storageKey),
      resource_type: RESOURCE_TYPE,
      type: DELIVERY_TYPE,
      overwrite: false,
    });
    // With overwrite: false Cloudinary keeps the old asset and reports existing: true.
    // Keys are unique, so a collision means something is wrong (local disk fails the same way).
    if (result.existing) {
      throw new Error("A stored file already exists for this storage key");
    }
  }

  async read(storageKey: string): Promise<Buffer> {
    const url = this.client.url(this.publicIdFor(storageKey), {
      resource_type: RESOURCE_TYPE,
      type: DELIVERY_TYPE,
      sign_url: true,
      secure: true,
    });
    const response = await this.fetchFn(url, { signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
    if (!response.ok) {
      throw new Error(`Cloudinary returned HTTP ${response.status} for a stored file`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  async delete(storageKey: string): Promise<void> {
    const { result } = await this.client.destroy(this.publicIdFor(storageKey), {
      resource_type: RESOURCE_TYPE,
      type: DELIVERY_TYPE,
      invalidate: true,
    });
    // Deleting a key that does not exist is not an error (StorageProvider contract).
    if (result !== "ok" && result !== "not found") {
      throw new Error(`Cloudinary could not delete a stored file (result: ${String(result)})`);
    }
  }
}
