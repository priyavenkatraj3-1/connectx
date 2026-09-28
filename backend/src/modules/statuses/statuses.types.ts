import type { PublicProfile } from "../users/users.types";

export type StatusType = "text" | "image" | "video";

/**
 * Who may view a status. Enforced on the server (StatusesRepository.isVisibleTo):
 *   everyone — anyone who shares an active direct OR group chat with the owner
 *   contacts — anyone who shares an active direct chat with the owner
 *   selected — only the listed users
 *   except   — contacts, minus the listed users
 */
export type StatusVisibility = "everyone" | "contacts" | "selected" | "except";

export const STATUS_VISIBILITIES: readonly StatusVisibility[] = ["everyone", "contacts", "selected", "except"];

export const STATUS_BACKGROUND_COLORS = ["indigo", "rose", "emerald", "amber", "slate", "violet"] as const;
export type StatusBackgroundColor = (typeof STATUS_BACKGROUND_COLORS)[number];

/** Statuses expire this long after they're published. Decided by the server, never the client. */
export const STATUS_LIFETIME_MS = 24 * 60 * 60 * 1000;

export const STATUS_TEXT_MAX = 700;
/** Upper bound on selected/excluded users in one privacy list. */
export const STATUS_AUDIENCE_MAX = 256;

export interface StatusMediaDTO {
  attachmentId: string;
  kind: "image" | "video";
  mimeType: string;
  sizeBytes: number;
}

export interface StatusDTO {
  id: string;
  userId: string;
  type: StatusType;
  /** Text of a text status, or the caption of an image/video status. */
  text: string | null;
  backgroundColor: StatusBackgroundColor | null;
  media: StatusMediaDTO | null;
  createdAt: Date;
  expiresAt: Date;
  /** Whether the requesting user has viewed it (always true for your own). */
  viewedByMe: boolean;
}

/** Your own status, with the privacy details and view count only the owner may see. */
export interface OwnStatusDTO extends StatusDTO {
  visibility: StatusVisibility;
  /** The allow-list (selected) or deny-list (except); empty for everyone/contacts. */
  audienceUserIds: string[];
  viewCount: number;
}

export interface StatusFeedEntry {
  user: PublicProfile;
  statuses: StatusDTO[];
  hasUnseen: boolean;
  latestAt: Date;
}

export interface StatusListResponse {
  mine: OwnStatusDTO[];
  feed: StatusFeedEntry[];
}

export interface StatusViewerDTO {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  viewedAt: Date;
}

export interface StatusPrivacySettingsDTO {
  visibility: StatusVisibility;
  /** The default allow-list (selected) or deny-list (except). */
  userIds: string[];
}
