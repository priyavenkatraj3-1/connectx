/** Size of the uploaded profile picture (square, pixels). */
export const AVATAR_OUTPUT_SIZE = 512;
export const AVATAR_ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
/** Largest source image we'll try to open (the upload itself is a re-encoded 512px JPEG). */
export const AVATAR_SOURCE_MAX_BYTES = 10 * 1024 * 1024;
/** The server's limit for the uploaded picture (see backend AVATAR_MAX_BYTES). */
export const AVATAR_UPLOAD_MAX_BYTES = 2 * 1024 * 1024;
export const MAX_ZOOM = 3;

/** A reason the file can't be used, or null. Checked before the image is even decoded. */
export function precheckAvatarFile(file: File): string | null {
  if (!(AVATAR_ACCEPTED_TYPES as readonly string[]).includes(file.type)) return "Choose a JPEG, PNG or WebP image.";
  if (file.size === 0) return "That file is empty.";
  if (file.size > AVATAR_SOURCE_MAX_BYTES) return "That image is too large (10MB at most).";
  return null;
}

/** Where the square crop sits: `zoom` ≥ 1 (1 = the short side fills the square), centred on (cx, cy) in image pixels. */
export interface CropState {
  zoom: number;
  cx: number;
  cy: number;
}

export interface ImageSize {
  width: number;
  height: number;
}

/** The side, in image pixels, of the square the crop covers. */
export function cropSide(image: ImageSize, zoom: number): number {
  return Math.min(image.width, image.height) / zoom;
}

/** Keeps the crop square inside the image, whatever the zoom or drag. */
export function clampCrop(image: ImageSize, crop: CropState): CropState {
  const zoom = Math.min(MAX_ZOOM, Math.max(1, crop.zoom));
  const half = cropSide(image, zoom) / 2;
  return {
    zoom,
    cx: Math.min(image.width - half, Math.max(half, crop.cx)),
    cy: Math.min(image.height - half, Math.max(half, crop.cy)),
  };
}

export function centeredCrop(image: ImageSize): CropState {
  return { zoom: 1, cx: image.width / 2, cy: image.height / 2 };
}

/** The source rectangle (image pixels) to draw into the square output. */
export function cropRect(image: ImageSize, crop: CropState): { x: number; y: number; size: number } {
  const { zoom, cx, cy } = clampCrop(image, crop);
  const size = cropSide(image, zoom);
  return { x: cx - size / 2, y: cy - size / 2, size };
}

export interface LoadedImage extends ImageSize {
  element: HTMLImageElement;
  /** Object URL for previews; revoke with release(). */
  url: string;
  release(): void;
}

/** Decodes a picked file in the browser (it never leaves the device until uploaded). */
export function loadImageFile(file: File): Promise<LoadedImage> {
  const url = URL.createObjectURL(file);
  return new Promise((resolve, reject) => {
    const element = new Image();
    element.onload = () =>
      resolve({ element, url, width: element.naturalWidth, height: element.naturalHeight, release: () => URL.revokeObjectURL(url) });
    element.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Couldn't read that image."));
    };
    element.src = url;
  });
}

/**
 * Draws the crop into a 512×512 canvas and re-encodes it as JPEG. Re-encoding
 * also drops the original's metadata (EXIF, including any GPS location).
 */
export function renderAvatar(image: LoadedImage, crop: CropState): Promise<Blob> {
  const { x, y, size } = cropRect(image, crop);
  const canvas = document.createElement("canvas");
  canvas.width = AVATAR_OUTPUT_SIZE;
  canvas.height = AVATAR_OUTPUT_SIZE;
  const context = canvas.getContext("2d");
  if (!context) return Promise.reject(new Error("Your browser can't prepare the picture."));
  context.fillStyle = "#ffffff"; // transparent PNGs get a white background in JPEG
  context.fillRect(0, 0, AVATAR_OUTPUT_SIZE, AVATAR_OUTPUT_SIZE);
  context.drawImage(image.element, x, y, size, size, 0, 0, AVATAR_OUTPUT_SIZE, AVATAR_OUTPUT_SIZE);
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Couldn't prepare the picture."))), "image/jpeg", 0.9)
  );
}
