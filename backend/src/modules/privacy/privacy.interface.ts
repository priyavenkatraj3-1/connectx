export interface PrivacySettings {
  userId: string;
  lastSeenVisibility: "everyone" | "contacts" | "nobody";
  profilePhotoVisibility: "everyone" | "contacts" | "nobody";
  readReceiptsEnabled: boolean;
  aiFeaturesEnabled: boolean;
  aiMemoryEnabled: boolean;
  updatedAt: Date;
}

/**
 * Contract for user-controlled privacy and AI-consent settings. Implemented
 * in a later phase once the `privacy_settings` table is backed by a real
 * database. AI features (memory, chat search, etc.) must check
 * `aiFeaturesEnabled` / `aiMemoryEnabled` here before acting — see
 * docs/ai-roadmap.md and docs/security.md.
 */
export interface PrivacyService {
  getSettings(userId: string): Promise<PrivacySettings>;
  updateSettings(userId: string, updates: Partial<Omit<PrivacySettings, "userId" | "updatedAt">>): Promise<PrivacySettings>;
}
