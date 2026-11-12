import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { useAuth } from "../../context/AuthContext";
import { useEscapeKey } from "../../hooks/useEscapeKey";
import {
  AVATAR_ACCEPTED_TYPES,
  AVATAR_UPLOAD_MAX_BYTES,
  centeredCrop,
  clampCrop,
  cropSide,
  loadImageFile,
  MAX_ZOOM,
  precheckAvatarFile,
  renderAvatar,
  type CropState,
  type LoadedImage,
} from "../../lib/image/cropImage";
import { userService } from "../../services/userService";
import type { OwnProfile } from "../../types/user";
import { Button } from "../ui/Button";

/** On-screen size of the crop preview (CSS pixels). */
const PREVIEW_SIZE = 256;

interface ProfilePhotoControlProps {
  profile: OwnProfile;
  onChange(profile: OwnProfile): void;
}

/**
 * "Change photo" / "Remove photo" for your own profile. The picked image is
 * cropped to a square and re-encoded to a 512px JPEG in the browser, then
 * uploaded; the server checks it again (type from the bytes, size) and only
 * ever changes the signed-in user's picture.
 */
export function ProfilePhotoControl({ profile, onChange }: ProfilePhotoControlProps) {
  const { accessToken, updateUser } = useAuth();
  const inputRef = useRef<HTMLInputElement>(null);
  const [image, setImage] = useState<LoadedImage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRemoving, setIsRemoving] = useState(false);

  // Free the decoded image's object URL when it's replaced or the control unmounts.
  useEffect(() => () => image?.release(), [image]);

  async function pick(file: File | undefined) {
    if (inputRef.current) inputRef.current.value = ""; // picking the same file again still fires onChange
    if (!file) return;
    setError(null);
    const problem = precheckAvatarFile(file);
    if (problem) {
      setError(problem);
      return;
    }
    try {
      setImage(await loadImageFile(file));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't read that image.");
    }
  }

  function saved(updated: OwnProfile) {
    onChange(updated);
    updateUser({ avatarUrl: updated.avatarUrl });
    setImage(null);
  }

  async function remove() {
    if (!accessToken) return;
    setIsRemoving(true);
    setError(null);
    try {
      saved(await userService.removeAvatar(accessToken));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't remove your picture.");
    } finally {
      setIsRemoving(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => inputRef.current?.click()}>
          {profile.avatarUrl ? "Change photo" : "Add photo"}
        </Button>
        {profile.avatarUrl && (
          <Button variant="ghost" onClick={() => void remove()} isLoading={isRemoving}>
            Remove photo
          </Button>
        )}
      </div>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        Your profile photo is public: anyone with its link can view it, even without signing in. After you change or
        remove it, copies saved earlier may still be visible for a while.
      </p>
      <input
        ref={inputRef}
        type="file"
        accept={AVATAR_ACCEPTED_TYPES.join(",")}
        className="hidden"
        data-testid="avatar-input"
        onChange={(e) => void pick(e.target.files?.[0])}
      />
      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      {image && <CropDialog image={image} onCancel={() => setImage(null)} onSaved={saved} />}
    </div>
  );
}

function CropDialog({ image, onCancel, onSaved }: { image: LoadedImage; onCancel(): void; onSaved(profile: OwnProfile): void }) {
  const { accessToken } = useAuth();
  const [crop, setCrop] = useState<CropState>(() => centeredCrop(image));
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);

  const scale = PREVIEW_SIZE / cropSide(image, crop.zoom); // screen px per image px
  const update = (next: CropState) => setCrop(clampCrop(image, next));

  // Escape (or Cancel) during an upload cancels the upload; otherwise it closes the dialog.
  const cancel = () => {
    if (abortRef.current) abortRef.current.abort();
    else onCancel();
  };
  useEscapeKey(cancel);
  useEffect(() => () => abortRef.current?.abort(), []);

  async function save() {
    if (!accessToken) return;
    setError(null);
    setIsSaving(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const blob = await renderAvatar(image, crop);
      if (blob.size > AVATAR_UPLOAD_MAX_BYTES) throw new Error("That picture is too large to upload.");
      onSaved(await userService.uploadAvatar(accessToken, blob, controller.signal));
    } catch (err) {
      setError(controller.signal.aborted ? "Upload cancelled." : err instanceof Error ? err.message : "Couldn't upload your picture.");
    } finally {
      abortRef.current = null;
      setIsSaving(false);
    }
  }

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (isSaving) return;
    dragRef.current = { x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }
  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.x;
    const dy = e.clientY - dragRef.current.y;
    dragRef.current = { x: e.clientX, y: e.clientY };
    update({ ...crop, cx: crop.cx - dx / scale, cy: crop.cy - dy / scale });
  }
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const step = cropSide(image, crop.zoom) * 0.05;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const move = moves[e.key];
    if (!move || isSaving) return;
    e.preventDefault();
    update({ ...crop, cx: crop.cx + move[0], cy: crop.cy + move[1] });
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="crop-title"
        className="flex w-full max-w-sm flex-col items-center gap-4 rounded-xl bg-white p-5 dark:bg-surface-dark-subtle"
      >
        <h2 id="crop-title" className="self-start text-base font-semibold text-slate-900 dark:text-slate-100">
          Profile photo
        </h2>
        <div
          role="img"
          aria-label="Crop preview. Drag or use the arrow keys to move the photo."
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={() => (dragRef.current = null)}
          onPointerCancel={() => (dragRef.current = null)}
          onKeyDown={onKeyDown}
          className="relative cursor-move touch-none overflow-hidden rounded-full bg-slate-200 outline-none ring-brand-500 focus-visible:ring-2 dark:bg-slate-700"
          style={{ width: PREVIEW_SIZE, height: PREVIEW_SIZE }}
        >
          <img
            src={image.url}
            alt=""
            draggable={false}
            className="pointer-events-none absolute max-w-none select-none"
            style={{
              width: image.width * scale,
              height: image.height * scale,
              left: PREVIEW_SIZE / 2 - clampCrop(image, crop).cx * scale,
              top: PREVIEW_SIZE / 2 - clampCrop(image, crop).cy * scale,
            }}
          />
        </div>
        <label className="flex w-full items-center gap-3 text-sm text-slate-600 dark:text-slate-300">
          Zoom
          <input
            type="range"
            min={1}
            max={MAX_ZOOM}
            step={0.01}
            value={crop.zoom}
            disabled={isSaving}
            onChange={(e) => update({ ...crop, zoom: Number(e.target.value) })}
            className="flex-1"
          />
        </label>
        {error && (
          <p role="alert" className="self-start text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
        <div className="flex w-full justify-end gap-2">
          <Button variant="ghost" onClick={cancel}>
            {isSaving ? "Cancel upload" : "Cancel"}
          </Button>
          <Button onClick={() => void save()} isLoading={isSaving}>
            Save photo
          </Button>
        </div>
      </div>
    </div>,
    document.body
  );
}
