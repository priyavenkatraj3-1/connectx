import type { PublicProfile } from "./user";

/** Mirrors backend/src/modules/statuses/statuses.types.ts. */
export type StatusType = "text" | "image" | "video";
export type StatusVisibility = "everyone" | "contacts" | "selected" | "except";
export type StatusBackgroundColor = "indigo" | "rose" | "emerald" | "amber" | "slate" | "violet";

export const STATUS_BACKGROUND_COLORS: StatusBackgroundColor[] = ["indigo", "rose", "emerald", "amber", "slate", "violet"];
export const STATUS_TEXT_MAX = 700;

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
  text: string | null;
  backgroundColor: StatusBackgroundColor | null;
  media: StatusMediaDTO | null;
  createdAt: string;
  expiresAt: string;
  viewedByMe: boolean;
}

export interface OwnStatusDTO extends StatusDTO {
  visibility: StatusVisibility;
  audienceUserIds: string[];
  viewCount: number;
}

export interface StatusFeedEntry {
  user: PublicProfile;
  statuses: StatusDTO[];
  hasUnseen: boolean;
  latestAt: string;
}

export interface StatusListResponse {
  mine: OwnStatusDTO[];
  feed: StatusFeedEntry[];
}

export interface StatusViewerDTO {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  viewedAt: string;
}

export interface StatusPrivacy {
  visibility: StatusVisibility;
  userIds: string[];
}

export interface CreateStatusInput {
  type: StatusType;
  text?: string;
  backgroundColor?: StatusBackgroundColor;
  attachmentId?: string;
  privacy?: StatusPrivacy;
}
