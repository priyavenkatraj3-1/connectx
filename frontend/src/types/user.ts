export interface PublicProfile {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  statusMessage: string | null;
}

export interface OwnProfile {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string | null;
  statusMessage: string | null;
  createdAt: string;
}

export interface ProfileUpdateInput {
  displayName?: string;
  bio?: string | null;
  statusMessage?: string | null;
  avatarUrl?: string | null;
}
