import { useState } from "react";
import { useAttachmentUrl } from "../../hooks/useAttachmentUrl";
import { formatFileSize } from "../../services/mediaService";
import type { AttachmentDTO } from "../../types/media";
import { DownloadIcon, FileIcon } from "../ui/icons";

interface AttachmentViewProps {
  attachment: AttachmentDTO;
  /** Styling hint: own messages sit on the brand-colored bubble. */
  isOwn: boolean;
}

function MediaPlaceholder({ label, isOwn }: { label: string; isOwn: boolean }) {
  return (
    <div
      className={`flex h-40 w-60 max-w-full items-center justify-center rounded-lg text-xs ${
        isOwn ? "bg-white/10 text-white/80" : "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400"
      }`}
    >
      {label}
    </div>
  );
}

function InlineMedia({ attachment, isOwn }: AttachmentViewProps) {
  const { status, url, error } = useAttachmentUrl(attachment.id);

  if (status === "error") return <MediaPlaceholder label={error ?? "Couldn't load media"} isOwn={isOwn} />;
  if (status !== "ready" || !url) return <MediaPlaceholder label="Loading…" isOwn={isOwn} />;

  if (attachment.kind === "image") {
    return (
      <img
        src={url}
        alt={attachment.originalFilename}
        className="max-h-72 w-auto max-w-full rounded-lg object-contain"
      />
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

/** Documents and generic files: a file card; bytes are only fetched when the user asks to download. */
function FileCard({ attachment, isOwn }: AttachmentViewProps) {
  const [requested, setRequested] = useState(false);
  const { status, url, error } = useAttachmentUrl(attachment.id, requested);

  return (
    <div
      className={`flex w-64 max-w-full items-center gap-3 rounded-lg p-2.5 ${
        isOwn ? "bg-white/10" : "bg-slate-100 dark:bg-slate-800"
      }`}
    >
      <FileIcon className={`shrink-0 ${isOwn ? "text-white/80" : "text-slate-500"}`} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium" title={attachment.originalFilename}>
          {attachment.originalFilename}
        </p>
        <p className={`text-xs ${isOwn ? "text-white/70" : "text-slate-400"}`}>
          {formatFileSize(attachment.sizeBytes)}
          {status === "error" && error ? ` · ${error}` : ""}
        </p>
      </div>
      {status === "ready" && url ? (
        <a
          href={url}
          download={attachment.originalFilename}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg hover:bg-black/10"
          aria-label={`Save ${attachment.originalFilename}`}
        >
          <DownloadIcon width={18} height={18} />
        </a>
      ) : (
        <button
          type="button"
          onClick={() => setRequested(true)}
          disabled={status === "loading"}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg hover:bg-black/10 disabled:opacity-50"
          aria-label={`Download ${attachment.originalFilename}`}
        >
          {status === "loading" ? (
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />
          ) : (
            <DownloadIcon width={18} height={18} />
          )}
        </button>
      )}
    </div>
  );
}

export function AttachmentView({ attachment, isOwn }: AttachmentViewProps) {
  if (attachment.kind === "image" || attachment.kind === "video" || attachment.kind === "audio") {
    return <InlineMedia attachment={attachment} isOwn={isOwn} />;
  }
  return <FileCard attachment={attachment} isOwn={isOwn} />;
}
