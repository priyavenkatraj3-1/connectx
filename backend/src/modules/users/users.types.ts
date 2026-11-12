export interface OwnProfile {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string | null;
  statusMessage: string | null;
  createdAt: Date;
}

export interface PublicProfile {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  statusMessage: string | null;
}

/**
 * What GET /users/:id returns. `bio` is included only for the user
 * themselves and for people who share an active conversation with them —
 * not for every signed-in user who knows the ID.
 */
export interface ContactProfile extends PublicProfile {
  bio?: string | null;
}

export interface ProfileUpdateInput {
  displayName?: string;
  bio?: string | null;
  statusMessage?: string | null;
  avatarUrl?: string | null;
}
