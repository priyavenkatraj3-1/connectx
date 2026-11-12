import { useEffect, useState } from "react";
import { API_BASE_URL } from "../../services/apiClient";

interface AvatarProps {
  name: string;
  size?: "sm" | "md" | "lg";
  imageUrl?: string;
}

const SIZE_CLASSES = {
  sm: "h-8 w-8 text-xs",
  md: "h-11 w-11 text-sm",
  lg: "h-16 w-16 text-lg",
};

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const initials = parts.slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "");
  return initials.join("") || "?";
}

/**
 * Uploaded profile pictures are stored as a server path
 * ("/api/v1/users/<id>/avatar/<avatarId>"); the API may live on another
 * origin than the app, so resolve them against the API. External http(s)
 * URLs are used as they are.
 */
export function resolveAvatarUrl(url: string): string {
  if (!url.startsWith("/api/")) return url;
  return new URL(url, new URL(API_BASE_URL, window.location.href)).toString();
}

export function Avatar({ name, size = "md", imageUrl }: AvatarProps) {
  // A picture that fails to load (removed, offline, bad external link) falls back to initials.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  useEffect(() => setFailedUrl(null), [imageUrl]);

  if (imageUrl && failedUrl !== imageUrl) {
    return (
      <img
        src={resolveAvatarUrl(imageUrl)}
        alt={name}
        onError={() => setFailedUrl(imageUrl)}
        className={`${SIZE_CLASSES[size]} shrink-0 rounded-full object-cover`}
      />
    );
  }

  return (
    <div
      className={`${SIZE_CLASSES[size]} flex items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-accent-500 font-semibold text-white`}
      aria-hidden="true"
    >
      {getInitials(name)}
    </div>
  );
}
