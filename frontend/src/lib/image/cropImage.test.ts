import { describe, expect, it } from "vitest";
import { AVATAR_SOURCE_MAX_BYTES, centeredCrop, clampCrop, cropRect, MAX_ZOOM, precheckAvatarFile } from "./cropImage";

const file = (type: string, size = 1000) => new File([new Uint8Array(size)], "pic", { type });

describe("precheckAvatarFile", () => {
  it("accepts JPEG, PNG and WebP and explains everything else", () => {
    expect(precheckAvatarFile(file("image/jpeg"))).toBeNull();
    expect(precheckAvatarFile(file("image/png"))).toBeNull();
    expect(precheckAvatarFile(file("image/webp"))).toBeNull();
    expect(precheckAvatarFile(file("image/svg+xml"))).toBe("Choose a JPEG, PNG or WebP image.");
    expect(precheckAvatarFile(file("image/gif"))).toBe("Choose a JPEG, PNG or WebP image.");
    expect(precheckAvatarFile(file("application/pdf"))).toBe("Choose a JPEG, PNG or WebP image.");
    expect(precheckAvatarFile(file("image/png", 0))).toBe("That file is empty.");
    expect(precheckAvatarFile(file("image/png", AVATAR_SOURCE_MAX_BYTES + 1))).toBe("That image is too large (10MB at most).");
  });
});

describe("crop geometry", () => {
  const landscape = { width: 800, height: 400 };

  it("starts centred with the short side filling the square", () => {
    expect(cropRect(landscape, centeredCrop(landscape))).toEqual({ x: 200, y: 0, size: 400 });
  });

  it("zooming shrinks the square around its centre", () => {
    expect(cropRect(landscape, { zoom: 2, cx: 400, cy: 200 })).toEqual({ x: 300, y: 100, size: 200 });
  });

  it("never lets the square leave the image, and bounds the zoom", () => {
    expect(cropRect(landscape, { zoom: 1, cx: -1000, cy: 9999 })).toEqual({ x: 0, y: 0, size: 400 });
    expect(cropRect(landscape, { zoom: 1, cx: 9999, cy: -5 })).toEqual({ x: 400, y: 0, size: 400 });
    expect(clampCrop(landscape, { zoom: 10, cx: 400, cy: 200 }).zoom).toBe(MAX_ZOOM);
    expect(clampCrop(landscape, { zoom: 0.1, cx: 400, cy: 200 }).zoom).toBe(1);
  });
});
