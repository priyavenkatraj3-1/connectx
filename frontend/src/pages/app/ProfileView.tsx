import { useEffect, useState } from "react";
import { Avatar } from "../../components/ui/Avatar";
import { Button } from "../../components/ui/Button";
import { ErrorState } from "../../components/common/ErrorState";
import { Input } from "../../components/ui/Input";
import { LoadingState } from "../../components/common/LoadingState";
import { useAuth } from "../../context/AuthContext";
import { userService } from "../../services/userService";
import type { OwnProfile } from "../../types/user";

export function ProfileView() {
  const { accessToken } = useAuth();
  const [profile, setProfile] = useState<OwnProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [statusMessage, setStatusMessage] = useState("");

  function load() {
    if (!accessToken) return;
    setIsLoading(true);
    setError(null);
    userService
      .getMe(accessToken)
      .then((p) => {
        setProfile(p);
        setDisplayName(p.displayName);
        setBio(p.bio ?? "");
        setStatusMessage(p.statusMessage ?? "");
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load profile"))
      .finally(() => setIsLoading(false));
  }

  useEffect(load, [accessToken]);

  async function handleSave() {
    if (!accessToken) return;
    setIsSaving(true);
    setError(null);
    try {
      const updated = await userService.updateMe(accessToken, {
        displayName: displayName.trim(),
        bio: bio.trim() || null,
        statusMessage: statusMessage.trim() || null,
      });
      setProfile(updated);
      setIsEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save profile");
    } finally {
      setIsSaving(false);
    }
  }

  if (isLoading) return <LoadingState label="Loading profile…" />;
  if (error && !profile) return <ErrorState message={error} onRetry={load} />;
  if (!profile) return null;

  return (
    <div className="flex flex-1 flex-col overflow-y-auto p-8">
      <div className="mx-auto w-full max-w-xl">
        <h1 className="mb-6 text-xl font-semibold text-slate-900 dark:text-slate-100">Your Profile</h1>

        <div className="rounded-xl2 border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-surface-dark-subtle">
          {!isEditing ? (
            <div className="flex items-center gap-5">
              <Avatar name={profile.displayName} imageUrl={profile.avatarUrl ?? undefined} size="lg" />
              <div className="flex-1">
                <p className="text-lg font-medium text-slate-900 dark:text-slate-100">{profile.displayName}</p>
                <p className="text-sm text-slate-500 dark:text-slate-400">{profile.email}</p>
                {profile.statusMessage && (
                  <p className="mt-1 text-sm text-slate-400">{profile.statusMessage}</p>
                )}
              </div>
              <Button variant="secondary" onClick={() => setIsEditing(true)}>
                Edit profile
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-4">
                <Avatar name={displayName || profile.displayName} imageUrl={profile.avatarUrl ?? undefined} size="lg" />
              </div>
              <Input label="Display name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
              <Input
                label="Status"
                value={statusMessage}
                onChange={(e) => setStatusMessage(e.target.value)}
                placeholder="e.g. Available"
              />
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-slate-700 dark:text-slate-200">Bio</span>
                <textarea
                  value={bio}
                  onChange={(e) => setBio(e.target.value)}
                  rows={3}
                  maxLength={280}
                  className="rounded-lg border border-slate-200 px-3.5 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 dark:border-slate-700 dark:bg-surface-dark"
                />
              </label>
              {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setIsEditing(false)} disabled={isSaving}>
                  Cancel
                </Button>
                <Button onClick={() => void handleSave()} isLoading={isSaving} disabled={!displayName.trim()}>
                  Save
                </Button>
              </div>
            </div>
          )}
        </div>

        <div className="mt-6 rounded-xl2 border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-surface-dark-subtle">
          <h2 className="mb-2 text-sm font-semibold text-slate-900 dark:text-slate-100">About</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {profile.bio || "No bio yet. Click “Edit profile” to add one."}
          </p>
        </div>
      </div>
    </div>
  );
}
