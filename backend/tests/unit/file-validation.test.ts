import { mkdtempSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, describe, expect, it } from "vitest";
import { sanitizeFilename, validateUploadedFile } from "../../src/modules/media/file-validation";
import { LocalDiskStorageProvider } from "../../src/modules/media/storage/local-disk.storage";
import { buildStorageKey } from "../../src/modules/media/storage/storage-provider.interface";
import { SAMPLE_FILES } from "../helpers/fixtures";

const ONE_MB = 1024 * 1024;

describe("validateUploadedFile", () => {
  it.each([
    ["photo.png", SAMPLE_FILES.png, "image/png", "image"],
    ["photo.JPG", SAMPLE_FILES.jpg, "image/jpeg", "image"],
    ["clip.mp4", SAMPLE_FILES.mp4, "video/mp4", "video"],
    ["voice.ogg", SAMPLE_FILES.ogg, "audio/ogg", "audio"],
    ["report.pdf", SAMPLE_FILES.pdf, "application/pdf", "document"],
    ["notes.txt", SAMPLE_FILES.txt, "text/plain", "document"],
  ])("accepts %s as %s", (name, data, mimeType, kind) => {
    const result = validateUploadedFile({ originalName: name, data }, ONE_MB);
    expect(result).toMatchObject({ ok: true, mimeType, kind, sizeBytes: data.length });
  });

  it("rejects empty files", () => {
    expect(validateUploadedFile({ originalName: "a.png", data: Buffer.alloc(0) }, ONE_MB)).toMatchObject({ ok: false, statusCode: 400 });
  });

  it("rejects files over the size limit with 413", () => {
    const big = Buffer.concat([SAMPLE_FILES.png, Buffer.alloc(ONE_MB)]);
    expect(validateUploadedFile({ originalName: "big.png", data: big }, ONE_MB)).toMatchObject({ ok: false, statusCode: 413 });
  });

  it.each(["payload.exe", "page.html", "vector.svg", "script.js", "noextension"])("rejects the disallowed name %s", (name) => {
    expect(validateUploadedFile({ originalName: name, data: SAMPLE_FILES.png }, ONE_MB)).toMatchObject({ ok: false, statusCode: 415 });
  });

  it("rejects an executable disguised with an allowed extension (magic bytes don't match)", () => {
    expect(validateUploadedFile({ originalName: "cute-cat.png", data: SAMPLE_FILES.exe }, ONE_MB)).toMatchObject({
      ok: false,
      statusCode: 415,
    });
    expect(validateUploadedFile({ originalName: "readme.txt", data: SAMPLE_FILES.exe }, ONE_MB)).toMatchObject({ ok: false });
  });

  it("does not trust the client MIME type: a contradicting declared type is rejected, and the stored type comes from the file", () => {
    expect(
      validateUploadedFile({ originalName: "photo.png", declaredMimeType: "text/html", data: SAMPLE_FILES.png }, ONE_MB)
    ).toMatchObject({ ok: false, statusCode: 415 });

    // A same-family but wrong declared subtype is tolerated, but never stored.
    expect(
      validateUploadedFile({ originalName: "photo.png", declaredMimeType: "image/gif", data: SAMPLE_FILES.png }, ONE_MB)
    ).toMatchObject({ ok: true, mimeType: "image/png" });

    expect(
      validateUploadedFile({ originalName: "photo.png", declaredMimeType: "application/octet-stream", data: SAMPLE_FILES.png }, ONE_MB)
    ).toMatchObject({ ok: true, mimeType: "image/png" });
  });
});

describe("sanitizeFilename", () => {
  it.each([
    ["../../etc/passwd.txt", "passwd.txt"],
    ["..\\..\\windows\\system32\\evil.pdf", "evil.pdf"],
    ["..", "file"],
    [".hidden.png", "hidden.png"],
    ["my\u0000file\u001f.png", "myfile.png"],
    ['bad"name<>|?.png', "bad_name____.png"],
    ["   ", "file"],
    ["résumé 2024.pdf", "résumé 2024.pdf"],
  ])("sanitizes %j to %j", (input, expected) => {
    expect(sanitizeFilename(input)).toBe(expected);
  });

  it("truncates very long names but keeps the extension", () => {
    const result = sanitizeFilename(`${"a".repeat(500)}.pdf`);
    expect(result.length).toBeLessThanOrEqual(120);
    expect(result.endsWith(".pdf")).toBe(true);
  });
});

describe("LocalDiskStorageProvider", () => {
  const root = mkdtempSync(join(tmpdir(), "connectx-storage-"));
  const storage = new LocalDiskStorageProvider(root);
  const conversationId = "11111111-1111-4111-8111-111111111111";
  const attachmentId = "22222222-2222-4222-8222-222222222222";

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("round-trips bytes under a server-generated key", async () => {
    const key = buildStorageKey(conversationId, attachmentId);
    await storage.save(key, SAMPLE_FILES.pdf);
    expect(await storage.read(key)).toEqual(SAMPLE_FILES.pdf);
    expect(readdirSync(join(root, conversationId))).toEqual([attachmentId]);
    await storage.delete(key);
    await expect(storage.read(key)).rejects.toThrow();
  });

  it.each(["../escape", `${conversationId}/../../escape`, "/etc/passwd", `${conversationId}\\..\\x`, ""])(
    "refuses the path-traversal key %j",
    async (key) => {
      await expect(storage.save(key, Buffer.from("x"))).rejects.toThrow(/Invalid storage key/);
      await expect(storage.read(key)).rejects.toThrow(/Invalid storage key/);
      await expect(storage.delete(key)).rejects.toThrow(/Invalid storage key/);
    }
  );
});
