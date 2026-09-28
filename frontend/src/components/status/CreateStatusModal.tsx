import { useEffect, useRef, useState, type FormEvent } from "react";
import { useAuth } from "../../context/AuthContext";
import { guessKind, mediaService, precheckStatusFile, type UploadHandle } from "../../services/mediaService";
import { statusService } from "../../services/statusService";
import {
  STATUS_BACKGROUND_COLORS,
  STATUS_TEXT_MAX,
  type OwnStatusDTO,
  type StatusBackgroundColor,
  type StatusPrivacy,
} from "../../types/status";
import { Button } from "../ui/Button";
import { ImageIcon, LockIcon, TypeIcon, VideoIcon } from "../ui/icons";
import { STATUS_BACKGROUND_CLASSES } from "./statusStyles";
import { describePrivacy, StatusPrivacyPicker } from "./StatusPrivacyPicker";

type Mode = "text" | "image" | "video";

const MODES: Array<{ mode: Mode; label: string; Icon: typeof TypeIcon }> = [
  { mode: "text", label: "Text", Icon: TypeIcon },
  { mode: "image", label: "Photo", Icon: ImageIcon },
  { mode: "video", label: "Video", Icon: VideoIcon },
];

interface CreateStatusModalProps {
  onClose(): void;
  onCreated(status: OwnStatusDTO): void;
}

export function CreateStatusModal({ onClose, onCreated }: CreateStatusModalProps) {
  const { accessToken } = useAuth();
  const [mode, setMode] = useState<Mode>("text");
  const [text, setText] = useState("");
  const [background, setBackground] = useState<StatusBackgroundColor>("indigo");
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [privacy, setPrivacy] = useState<StatusPrivacy | null>(null);
  const [isEditingPrivacy, setIsEditingPrivacy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [isPublishing, setIsPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const uploadRef = useRef<UploadHandle | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Start from the user's saved default privacy.
  useEffect(() => {
    if (!accessToken) return;
    statusService
      .getPrivacy(accessToken)
      .then(setPrivacy)
      .catch(() => setPrivacy({ visibility: "contacts", userIds: [] }));
  }, [accessToken]);

  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  function switchMode(next: Mode) {
    setMode(next);
    setFile(null);
    setError(null);
  }

  function handleFile(selected: File | undefined) {
    if (!selected) return;
    const problem = precheckStatusFile(selected);
    if (problem) {
      setError(problem);
      return;
    }
    if (guessKind(selected.name) !== mode) {
      setError(mode === "image" ? "Choose a photo (JPG, PNG, GIF or WebP)" : "Choose a video (MP4, MOV or WebM)");
      return;
    }
    setError(null);
    setFile(selected);
  }

  function handleCancel() {
    uploadRef.current?.abort();
    onClose();
  }

  const canPublish =
    !!privacy &&
    !isPublishing &&
    (mode === "text" ? text.trim().length > 0 : !!file) &&
    !(privacy.visibility === "selected" && privacy.userIds.length === 0);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!accessToken || !privacy || !canPublish) return;
    setIsPublishing(true);
    setError(null);

    let uploadedId: string | null = null;
    try {
      if (mode !== "text" && file) {
        setProgress(0);
        const handle = mediaService.uploadStatusMedia(accessToken, file, setProgress);
        uploadRef.current = handle;
        uploadedId = (await handle.promise).id;
      }
      const status = await statusService.create(accessToken, {
        type: mode,
        text: text.trim() || undefined,
        backgroundColor: mode === "text" ? background : undefined,
        attachmentId: uploadedId ?? undefined,
        privacy,
      });
      onCreated(status);
      onClose();
    } catch (err) {
      // Don't leave an orphaned upload behind if publishing failed after it.
      if (uploadedId) void mediaService.remove(accessToken, uploadedId).catch(() => undefined);
      setError(err instanceof Error ? err.message : "Couldn't publish your status");
      setIsPublishing(false);
      setProgress(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:pt-12" onClick={handleCancel}>
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        aria-labelledby="create-status-title"
        className="flex w-full max-w-md flex-col rounded-xl2 bg-white shadow-xl dark:bg-surface-dark-subtle"
      >
        <div className="border-b border-slate-100 p-4 dark:border-slate-800">
          <h2 id="create-status-title" className="text-base font-semibold text-slate-900 dark:text-slate-100">
            New status
          </h2>
        </div>

        <div className="flex flex-col gap-4 p-4">
          <div role="tablist" aria-label="Status type" className="grid grid-cols-3 gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800">
            {MODES.map(({ mode: m, label, Icon }) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={mode === m}
                onClick={() => switchMode(m)}
                className={`flex items-center justify-center gap-1.5 rounded-md py-1.5 text-sm font-medium ${
                  mode === m ? "bg-white text-slate-900 shadow-sm dark:bg-surface-dark dark:text-slate-100" : "text-slate-500"
                }`}
              >
                <Icon width={16} height={16} />
                {label}
              </button>
            ))}
          </div>

          {mode === "text" ? (
            <>
              <div className={`flex min-h-[180px] items-center justify-center rounded-xl p-5 ${STATUS_BACKGROUND_CLASSES[background]}`}>
                <textarea
                  aria-label="Status text"
                  value={text}
                  maxLength={STATUS_TEXT_MAX}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="Type a status"
                  rows={4}
                  className="w-full resize-none bg-transparent text-center text-lg font-medium text-white placeholder:text-white/60 focus:outline-none"
                />
              </div>
              <div className="flex items-center justify-between">
                <div className="flex gap-2" role="radiogroup" aria-label="Background color">
                  {STATUS_BACKGROUND_COLORS.map((color) => (
                    <button
                      key={color}
                      type="button"
                      role="radio"
                      aria-checked={background === color}
                      aria-label={`${color} background`}
                      onClick={() => setBackground(color)}
                      className={`h-7 w-7 rounded-full ${STATUS_BACKGROUND_CLASSES[color]} ${
                        background === color ? "ring-2 ring-brand-500 ring-offset-2 dark:ring-offset-surface-dark-subtle" : ""
                      }`}
                    />
                  ))}
                </div>
                <span className="text-xs text-slate-400">
                  {text.length}/{STATUS_TEXT_MAX}
                </span>
              </div>
            </>
          ) : (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept={mode === "image" ? ".jpg,.jpeg,.png,.gif,.webp" : ".mp4,.mov,.webm"}
                className="hidden"
                aria-label={mode === "image" ? "Choose a photo" : "Choose a video"}
                onChange={(e) => handleFile(e.target.files?.[0])}
              />
              {previewUrl ? (
                <div className="overflow-hidden rounded-xl bg-black">
                  {mode === "image" ? (
                    <img src={previewUrl} alt="Status preview" className="max-h-72 w-full object-contain" />
                  ) : (
                    <video src={previewUrl} controls className="max-h-72 w-full" />
                  )}
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="flex h-40 flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-200 text-sm text-slate-500 hover:border-brand-400 dark:border-slate-700"
                >
                  {mode === "image" ? <ImageIcon width={28} height={28} /> : <VideoIcon width={28} height={28} />}
                  {mode === "image" ? "Choose a photo" : "Choose a video"}
                </button>
              )}
              {file && (
                <button type="button" onClick={() => fileInputRef.current?.click()} className="self-start text-xs text-brand-600">
                  Choose a different file
                </button>
              )}
              <input
                aria-label="Caption"
                value={text}
                maxLength={STATUS_TEXT_MAX}
                onChange={(e) => setText(e.target.value)}
                placeholder="Add a caption (optional)"
                className="rounded-lg border border-slate-200 px-3.5 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 dark:border-slate-700 dark:bg-surface-dark dark:text-slate-100"
              />
            </>
          )}

          {privacy && !isEditingPrivacy && (
            <div className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm dark:bg-slate-800/60">
              <LockIcon width={16} height={16} className="shrink-0 text-slate-400" />
              <span className="flex-1 text-slate-600 dark:text-slate-300" data-testid="privacy-summary">
                Visible to: {describePrivacy(privacy)}
              </span>
              <button type="button" onClick={() => setIsEditingPrivacy(true)} className="text-xs font-semibold text-brand-600">
                Change
              </button>
            </div>
          )}
          {privacy && isEditingPrivacy && <StatusPrivacyPicker value={privacy} onChange={setPrivacy} />}

          {progress !== null && (
            <div className="h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800" role="progressbar" aria-valuenow={Math.round(progress * 100)}>
              <div className="h-full bg-brand-500 transition-all" style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
          )}

          {error && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {error}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-100 p-4 dark:border-slate-800">
          <Button type="button" variant="ghost" onClick={handleCancel}>
            Cancel
          </Button>
          <Button type="submit" disabled={!canPublish} isLoading={isPublishing}>
            Publish
          </Button>
        </div>
      </form>
    </div>
  );
}
