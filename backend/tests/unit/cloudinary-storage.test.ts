import { describe, expect, it } from "vitest";
import {
  CloudinaryStorageProvider,
  createCloudinaryClient,
  parseCloudinaryUrl,
} from "../../src/modules/media/storage/cloudinary.storage";
import { createStorageProvider } from "../../src/modules/media/storage/create-storage-provider";
import { LocalDiskStorageProvider } from "../../src/modules/media/storage/local-disk.storage";
import { FakeCloudinary } from "../helpers/fakeCloudinary";

const CONVERSATION = "11111111-1111-4111-8111-111111111111";
const ATTACHMENT = "22222222-2222-4222-8222-222222222222";
const KEY = `${CONVERSATION}/${ATTACHMENT}`;
const STATUS_KEY = `statuses/${CONVERSATION}/${ATTACHMENT}`;

function setup() {
  const cloud = new FakeCloudinary();
  const provider = new CloudinaryStorageProvider(cloud.client, "connectx", cloud.fetch);
  return { cloud, provider };
}

describe("CloudinaryStorageProvider", () => {
  it("uploads as a private (authenticated) raw asset under the folder, without overwriting", async () => {
    const { cloud, provider } = setup();
    await provider.save(KEY, Buffer.from("bytes"));

    expect(cloud.calls).toEqual([
      {
        method: "upload",
        publicId: `connectx/${KEY}`,
        options: { public_id: `connectx/${KEY}`, resource_type: "raw", type: "authenticated", overwrite: false },
      },
    ]);
  });

  it("round-trips the exact bytes through a signed URL, for message and status keys", async () => {
    const { provider } = setup();
    const data = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    await provider.save(KEY, data);
    await provider.save(STATUS_KEY, Buffer.from("status"));

    expect((await provider.read(KEY)).equals(data)).toBe(true);
    expect((await provider.read(STATUS_KEY)).toString()).toBe("status");
  });

  it("never exposes the asset through an unsigned URL", async () => {
    const { cloud, provider } = setup();
    await provider.save(KEY, Buffer.from("secret"));
    const unsigned = cloud.client.url(`connectx/${KEY}`, { resource_type: "raw", type: "authenticated", sign_url: false, secure: true });
    expect((await cloud.fetch(unsigned, { signal: AbortSignal.timeout(1000) })).ok).toBe(false);
  });

  it("refuses to overwrite an existing key", async () => {
    const { provider } = setup();
    await provider.save(KEY, Buffer.from("first"));
    await expect(provider.save(KEY, Buffer.from("second"))).rejects.toThrow(/already exists/);
    expect((await provider.read(KEY)).toString()).toBe("first");
  });

  it("rejects malformed storage keys before calling Cloudinary", async () => {
    const { cloud, provider } = setup();
    for (const key of ["../etc/passwd", `${CONVERSATION}/../${ATTACHMENT}`, "connectx/other"]) {
      await expect(provider.save(key, Buffer.from("x"))).rejects.toThrow(/Invalid storage key/);
      await expect(provider.read(key)).rejects.toThrow(/Invalid storage key/);
      await expect(provider.delete(key)).rejects.toThrow(/Invalid storage key/);
    }
    expect(cloud.calls).toEqual([]);
  });

  it("fails a read when Cloudinary doesn't return the file", async () => {
    const { provider } = setup();
    await expect(provider.read(KEY)).rejects.toThrow(/HTTP 404/);
  });

  it("deletes the asset (invalidating cached copies), and treats a missing asset as already deleted", async () => {
    const { cloud, provider } = setup();
    await provider.save(KEY, Buffer.from("bytes"));
    await provider.delete(KEY);

    expect(cloud.assets.has(`connectx/${KEY}`)).toBe(false);
    expect(cloud.calls.at(-1)).toEqual({
      method: "destroy",
      publicId: `connectx/${KEY}`,
      options: { resource_type: "raw", type: "authenticated", invalidate: true },
    });
    await expect(provider.delete(KEY)).resolves.toBeUndefined();
  });

  it("reports an unexpected delete result as an error", async () => {
    const { cloud } = setup();
    const provider = new CloudinaryStorageProvider({ ...cloud.client, destroy: async () => ({ result: "error" }) }, "connectx", cloud.fetch);
    await expect(provider.delete(KEY)).rejects.toThrow(/could not delete/);
  });
});

describe("Cloudinary configuration", () => {
  it("parses CLOUDINARY_URL", () => {
    expect(parseCloudinaryUrl("cloudinary://123456:abc-DEF_secret@my-cloud")).toEqual({
      cloudName: "my-cloud",
      apiKey: "123456",
      apiSecret: "abc-DEF_secret",
    });
  });

  it("rejects malformed values without echoing the secret", () => {
    for (const value of ["not a url", "https://123:supersecret@my-cloud", "cloudinary://123@my-cloud", "cloudinary://:supersecret@my-cloud"]) {
      let message = "";
      try {
        parseCloudinaryUrl(value);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toMatch(/CLOUDINARY_URL/);
      expect(message).not.toContain("supersecret");
    }
  });

  it("the real SDK builds signed, authenticated, raw HTTPS URLs locally without leaking the secret", () => {
    const client = createCloudinaryClient({ cloudName: "my-cloud", apiKey: "123456", apiSecret: "supersecret" });
    const url = client.url(`connectx/${KEY}`, { resource_type: "raw", type: "authenticated", sign_url: true, secure: true });

    expect(url).toMatch(new RegExp(`^https://res\\.cloudinary\\.com/my-cloud/raw/authenticated/s--[A-Za-z0-9_-]{8}--/`));
    expect(url).toContain(`connectx/${KEY}`);
    expect(url).not.toContain("supersecret");
  });

  it("selects local disk by default and Cloudinary when configured", () => {
    const base = { uploadDir: "uploads", cloudinary: { url: undefined, folder: "connectx" } };
    expect(createStorageProvider({ ...base, mediaStorage: "local" })).toBeInstanceOf(LocalDiskStorageProvider);
    expect(
      createStorageProvider({ ...base, mediaStorage: "cloudinary", cloudinary: { url: "cloudinary://1:2@c", folder: "connectx" } })
    ).toBeInstanceOf(CloudinaryStorageProvider);
    expect(() => createStorageProvider({ ...base, mediaStorage: "cloudinary" })).toThrow(/requires CLOUDINARY_URL/);
  });
});
