import { useEffect, useState } from "react";
import { useAuth } from "../../context/AuthContext";
import { userService } from "../../services/userService";
import type { ContactProfile } from "../../types/user";
import { Avatar } from "../ui/Avatar";
import { CloseIcon } from "../ui/icons";

interface ContactInfoPanelProps {
  /** The other person in a direct chat. */
  userId: string;
  /** Shown while the profile loads (from the chat list), so the panel never starts blank. */
  fallback: { displayName: string; avatarUrl: string | null; statusMessage: string | null };
  onClose(): void;
}

/**
 * Contact info side panel for a direct chat: avatar, name, status message
 * and bio. The bio comes from the server only when you share a chat with
 * this person (always true here, unless they left or were removed).
 */
export function ContactInfoPanel({ userId, fallback, onClose }: ContactInfoPanelProps) {
  const { accessToken } = useAuth();
  const [profile, setProfile] = useState<ContactProfile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    setProfile(null);
    setError(null);
    userService
      .getPublicProfile(accessToken, userId)
      .then((found) => {
        if (!cancelled) setProfile(found);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Couldn't load this profile");
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken, userId]);

  const shown = profile ?? fallback;

  return (
    <aside
      className="flex w-full shrink-0 flex-col border-l border-slate-200 bg-white dark:border-slate-800 dark:bg-surface-dark md:w-80"
      aria-label="Contact info"
    >
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Contact info</h2>
        <button
          type="button"
          onClick={onClose}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
          aria-label="Close contact info"
        >
          <CloseIcon width={18} height={18} />
        </button>
      </div>

      <div className="flex flex-1 flex-col gap-5 overflow-y-auto p-4">
        {error && (
          <p role="alert" className="rounded-lg bg-red-50 p-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
            {error}
          </p>
        )}
        <div className="flex flex-col items-center gap-2 text-center">
          <Avatar name={shown.displayName} imageUrl={shown.avatarUrl ?? undefined} size="lg" />
          <p className="text-base font-semibold text-slate-900 dark:text-slate-100">{shown.displayName}</p>
          {shown.statusMessage && <p className="text-sm text-slate-500 dark:text-slate-400">{shown.statusMessage}</p>}
        </div>

        <section aria-labelledby="contact-about">
          <h3 id="contact-about" className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
            About
          </h3>
          {!profile && !error ? (
            <p className="text-sm text-slate-400">Loading…</p>
          ) : (
            <p className="whitespace-pre-wrap break-words text-sm text-slate-700 dark:text-slate-200">
              {profile?.bio || "No bio."}
            </p>
          )}
        </section>
      </div>
    </aside>
  );
}
