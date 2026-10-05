import type { CloudinaryClient, FetchLike } from "../../src/modules/media/storage/cloudinary.storage";

/**
 * In-memory stand-in for the Cloudinary API so the Cloudinary provider is
 * tested without credentials or network. Mirrors the behavior the provider
 * relies on: overwrite: false reports `existing`, destroy answers
 * "ok"/"not found", and only signed authenticated URLs are delivered.
 */
export class FakeCloudinary {
  readonly assets = new Map<string, { data: Buffer; resourceType: string; type: string }>();
  readonly calls: { method: string; publicId: string; options: Record<string, unknown> }[] = [];

  readonly client: CloudinaryClient = {
    upload: async (data, options) => {
      const publicId = String(options.public_id);
      this.calls.push({ method: "upload", publicId, options: { ...options } });
      if (this.assets.has(publicId) && options.overwrite === false) return { existing: true };
      this.assets.set(publicId, { data: Buffer.from(data), resourceType: String(options.resource_type), type: String(options.type) });
      return { existing: false };
    },
    destroy: async (publicId, options) => {
      this.calls.push({ method: "destroy", publicId, options: { ...options } });
      return { result: this.assets.delete(publicId) ? "ok" : "not found" };
    },
    url: (publicId, options) => {
      const signature = options.sign_url ? "s--fakesig--/" : "";
      return `https://res.fake-cloudinary.test/demo/${options.resource_type}/${options.type}/${signature}${publicId}`;
    },
  };

  readonly fetch: FetchLike = async (url) => {
    const match = /^https:\/\/res\.fake-cloudinary\.test\/demo\/([^/]+)\/([^/]+)\/(s--fakesig--\/)?(.+)$/.exec(url);
    const asset = match ? this.assets.get(match[4]!) : undefined;
    // Authenticated assets are only delivered through a signed URL.
    const deliverable = asset && match && asset.resourceType === match[1] && asset.type === match[2] && (asset.type !== "authenticated" || match[3]);
    return {
      ok: Boolean(deliverable),
      status: deliverable ? 200 : 404,
      arrayBuffer: async () => {
        const data = deliverable ? asset.data : Buffer.alloc(0);
        return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
      },
    };
  };
}
