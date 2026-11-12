import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAttachmentUrl } from "../../hooks/useAttachmentUrl";
import { useEscapeKey } from "../../hooks/useEscapeKey";
import { formatFileSize } from "../../services/mediaService";
import type { AttachmentDTO } from "../../types/media";
import { CloseIcon, DownloadIcon, EyeIcon, FileIcon } from "../ui/icons";

interface AttachmentViewProps {
  attachment: AttachmentDTO;
  /** Styling hint: own messages sit on the brand-colored bubble. */
  isOwn: boolean;
}

/** Saves an already-fetched (object URL) attachment under its original file name. */
function triggerDownload(url: string, fileName: string): void {
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function MediaPlaceholder({ label, isOwn, onRetry }: { label: string; isOwn: boolean; onRetry?: () => void }) {
  const className = `flex h-40 w-60 max-w-full flex-col items-center justify-center gap-1 rounded-lg px-3 text-center text-xs ${
    isOwn ? "bg-white/10 text-white/80" : "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400"
  }`;
  if (!onRetry) return <div className={className}>{label}</div>;
  return (
    <button type="button" onClick={onRetry} className={className}>
      <span>{label}</span>
      <span className="font-medium underline">Tap to retry</span>
    </button>
  );
}

/** Full-size view of an image that was already loaded through the authenticated API. */
function ImagePreview({ url, attachment, onClose }: { url: string; attachment: AttachmentDTO; onClose(): void }) {
  useEscapeKey(onClose);
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Preview of ${attachment.originalFilename}`}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/85 p-4"
      onClick={onClose}
    >
      <div className="flex w-full max-w-5xl items-center justify-between gap-2 text-white" onClick={(e) => e.stopPropagation()}>
        <p className="truncate text-sm font-medium">{attachment.originalFilename}</p>
        <div className="flex shrink-0 gap-1">
          <button
            type="button"
            onClick={() => triggerDownload(url, attachment.originalFilename)}
            className="flex h-9 w-9 items-center justify-center rounded-lg hover:bg-white/10"
            aria-label={`Download ${attachment.originalFilename}`}
          >
            <DownloadIcon width={20} height={20} />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-lg hover:bg-white/10"
            aria-label="Close preview"
          >
            <CloseIcon width={20} height={20} />
          </button>
        </div>
      </div>
      <img
        src={url}
        alt={attachment.originalFilename}
        className="max-h-[85vh] max-w-full object-contain"
        onClick={(e) => e.stopPropagation()}
      />
    </div>,
    document.body
  );
}

/** PDFs can be previewed in the app; Office documents are download-only (see docs/api.md, Media). */
export function isPreviewablePdf(attachment: AttachmentDTO): boolean {
  return attachment.mimeType === "application/pdf";
}

/**
 * In-app PDF preview. The bytes were fetched through the authenticated API
 * and are shown from a blob: URL by the browser's own PDF viewer — the file
 * never goes to a third-party viewer and no public link is created. Some
 * mobile browsers can't show PDFs inline, hence the download fallback.
 */
function PdfPreview({ url, attachment, onClose }: { url: string; attachment: AttachmentDTO; onClose(): void }) {
  useEscapeKey(onClose);
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Preview of ${attachment.originalFilename}`}
      className="fixed inset-0 z-50 flex flex-col items-center gap-3 bg-black/85 p-4"
      onClick={onClose}
    >
      <div className="flex w-full max-w-5xl items-center justify-between gap-2 text-white" onClick={(e) => e.stopPropagation()}>
        <p className="truncate text-sm font-medium">{attachment.originalFilename}</p>
        <div className="flex shrink-0 gap-1">
          <button
            type="button"
            onClick={() => triggerDownload(url, attachment.originalFilename)}
            className="flex h-9 w-9 items-center justify-center rounded-lg hover:bg-white/10"
            aria-label={`Download ${attachment.originalFilename}`}
          >
            <DownloadIcon width={20} height={20} />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-lg hover:bg-white/10"
            aria-label="Close preview"
          >
            <CloseIcon width={20} height={20} />
          </button>
        </div>
      </div>
      <iframe
        src={url}
        title={`PDF preview: ${attachment.originalFilename}`}
        className="w-full max-w-5xl flex-1 rounded-lg bg-white"
        onClick={(e) => e.stopPropagation()}
      />
      <p className="text-xs text-white/60" onClick={(e) => e.stopPropagation()}>
        Preview not showing? Your browser may not display PDFs inline —{" "}
        <button type="button" className="underline" onClick={() => triggerDownload(url, attachment.originalFilename)}>
          download it instead
        </button>
        .
      </p>
    </div>,
    document.body
  );
}

function InlineMedia({ attachment, isOwn }: AttachmentViewProps) {
  const { status, url, error, reload } = useAttachmentUrl(attachment.id);
  const [previewOpen, setPreviewOpen] = useState(false);

  if (status === "error") return <MediaPlaceholder label={error ?? "Couldn't load media"} isOwn={isOwn} onRetry={reload} />;
  if (status !== "ready" || !url) return <MediaPlaceholder label="Loading…" isOwn={isOwn} />;

  if (attachment.kind === "image") {
    return (
      <>
        <button
          type="button"
          onClick={() => setPreviewOpen(true)}
          className="block cursor-zoom-in rounded-lg"
          aria-label={`Open ${attachment.originalFilename}`}
        >
          <img
            src={url}
            alt={attachment.originalFilename}
            className="max-h-72 w-auto max-w-full rounded-lg object-contain"
          />
        </button>
        {previewOpen && <ImagePreview url={url} attachment={attachment} onClose={() => setPreviewOpen(false)} />}
      </>
    );
  }
  if (attachment.kind === "video") {
    return (
      <video src={url} controls preload="metadata" className="max-h-72 max-w-full rounded-lg">
        <track kind="captions" />
      </video>
    );
  }
  return <audio src={url} controls preload="metadata" className="w-64 max-w-full" aria-label={attachment.originalFilename} />;
}

/**
 * Documents and generic files: a file card; bytes are only fetched when the
 * user clicks it, then saved under the original file name. Later clicks
 * reuse the loaded copy; a failed load is retried on the next click.
 */
function FileCard({ attachment, isOwn }: AttachmentViewProps) {
  const [requested, setRequested] = useState(false);
  const { status, url, error, reload } = useAttachmentUrl(attachment.id, requested);
  /** What to do once the bytes have loaded: save them, or open the PDF preview. */
  const whenReady = useRef<"download" | "preview" | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const canPreview = isPreviewablePdf(attachment);

  useEffect(() => {
    if (status === "ready" && url && whenReady.current) {
      if (whenReady.current === "download") triggerDownload(url, attachment.originalFilename);
      else setPreviewOpen(true);
      whenReady.current = null;
    }
    if (status === "error") whenReady.current = null;
  }, [status, url, attachment.originalFilename]);

  function request(action: "download" | "preview") {
    if (status === "ready" && url) {
      if (action === "download") triggerDownload(url, attachment.originalFilename);
      else setPreviewOpen(true);
      return;
    }
    if (status === "loading") {
      whenReady.current = action;
      return;
    }
    whenReady.current = action;
    if (status === "error") reload();
    else setRequested(true);
  }

  const card = (
    <button
      type="button"
      onClick={() => request("download")}
      aria-busy={status === "loading"}
      aria-label={`Download ${attachment.originalFilename}`}
      className={`flex w-64 max-w-full items-center gap-3 rounded-lg p-2.5 text-left ${
        isOwn ? "bg-white/10 hover:bg-white/15" : "bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700"
      }`}
    >
      <FileIcon className={`shrink-0 ${isOwn ? "text-white/80" : "text-slate-500"}`} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium" title={attachment.originalFilename}>
          {attachment.originalFilename}
        </span>
        <span className={`block text-xs ${isOwn ? "text-white/70" : "text-slate-400"}`}>
          {formatFileSize(attachment.sizeBytes)}
          {status === "error" && error ? ` · ${error}` : ""}
        </span>
      </span>
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg" aria-hidden="true">
        {status === "loading" ? (
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
        ) : (
          <DownloadIcon width={18} height={18} />
        )}
      </span>
    </button>
  );

  if (!canPreview) return card;
  return (
    <div className="flex items-center gap-1">
      {card}
      <button
        type="button"
        onClick={() => request("preview")}
        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${
          isOwn ? "text-white/80 hover:bg-white/15" : "text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-700"
        }`}
        aria-label={`Preview ${attachment.originalFilename}`}
        title="Preview"
      >
        <EyeIcon width={18} height={18} />
      </button>
      {previewOpen && url && <PdfPreview url={url} attachment={attachment} onClose={() => setPreviewOpen(false)} />}
    </div>
  );
}

export function AttachmentView({ attachment, isOwn }: AttachmentViewProps) {
  if (attachment.kind === "image" || attachment.kind === "video" || attachment.kind === "audio") {
    return <InlineMedia attachment={attachment} isOwn={isOwn} />;
  }
  return <FileCard attachment={attachment} isOwn={isOwn} />;
}
