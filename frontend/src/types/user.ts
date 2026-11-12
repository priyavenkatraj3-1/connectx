export interface PublicProfile {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  statusMessage: string | null;
}

/** GET /users/:id — `bio` is present only if you share a chat with this person (the server decides). */
export interface ContactProfile extends PublicProfile {
  bio?: string | null;
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
