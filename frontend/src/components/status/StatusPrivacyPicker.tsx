import { useEffect, useState } from "react";
import { useAuth } from "../../context/AuthContext";
import { userService } from "../../services/userService";
import type { StatusPrivacy, StatusVisibility } from "../../types/status";
import type { PublicProfile } from "../../types/user";
import { MemberPicker } from "../groups/MemberPicker";

export const VISIBILITY_OPTIONS: Array<{ value: StatusVisibility; label: string; description: string }> = [
  {
    value: "contacts",
    label: "My contacts",
    description: "People you've chatted with one-to-one (you started the chat or replied in it).",
  },
  {
    value: "except",
    label: "My contacts except…",
    description: "Your contacts, minus the people you choose.",
  },
  {
    value: "selected",
    label: "Only share with…",
    description: "Only the people you choose — nobody else.",
  },
  {
    value: "everyone",
    label: "Everyone I chat with",
    description: "Your contacts plus everyone in your groups.",
  },
];

/** One-line summary of who can see a status, shown wherever privacy is chosen or displayed. */
export function describePrivacy(privacy: StatusPrivacy): string {
  const n = privacy.userIds.length;
  const people = `${n} ${n === 1 ? "person" : "people"}`;
  switch (privacy.visibility) {
    case "contacts":
      return "My contacts";
    case "everyone":
      return "Everyone I chat with (contacts and group members)";
    case "selected":
      return `Only ${people}`;
    case "except":
      return n === 0 ? "My contacts" : `My contacts except ${people}`;
  }
}

interface StatusPrivacyPickerProps {
  value: StatusPrivacy;
  onChange(value: StatusPrivacy): void;
}

/** Radio list of visibility options, plus a people picker for "only share with" / "except". */
export function StatusPrivacyPicker({ value, onChange }: StatusPrivacyPickerProps) {
  const { accessToken } = useAuth();
  const [profiles, setProfiles] = useState<PublicProfile[]>([]);

  // Resolve saved user IDs to names so the chips can show who's selected.
  useEffect(() => {
    if (!accessToken) return;
    const missing = value.userIds.filter((id) => !profiles.some((p) => p.id === id));
    if (missing.length === 0) return;
    let cancelled = false;
    void Promise.all(missing.map((id) => userService.getPublicProfile(accessToken, id).catch(() => null))).then((found) => {
      if (!cancelled) setProfiles((prev) => [...prev, ...found.filter((p): p is PublicProfile => p !== null)]);
    });
    return () => {
      cancelled = true;
    };
  }, [accessToken, value.userIds]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedProfiles = value.userIds
    .map((id) => profiles.find((p) => p.id === id))
    .filter((p): p is PublicProfile => !!p);
  const needsPeople = value.visibility === "selected" || value.visibility === "except";

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-medium text-slate-700 dark:text-slate-200">Who can see your status</legend>
      {VISIBILITY_OPTIONS.map((option) => (
        <label
          key={option.value}
          className={`flex cursor-pointer gap-3 rounded-lg border p-3 text-sm ${
            value.visibility === option.value
              ? "border-brand-500 bg-brand-50 dark:bg-brand-950/30"
              : "border-slate-200 dark:border-slate-700"
          }`}
        >
          <input
            type="radio"
            name="status-visibility"
            value={option.value}
            checked={value.visibility === option.value}
            onChange={() => onChange({ visibility: option.value, userIds: value.userIds })}
            className="mt-0.5"
          />
          <span>
            <span className="block font-medium text-slate-900 dark:text-slate-100">{option.label}</span>
            <span className="block text-xs text-slate-500 dark:text-slate-400">{option.description}</span>
          </span>
        </label>
      ))}

      {needsPeople && (
        <div className="flex flex-col gap-1.5 pt-1">
          <span className="text-sm font-medium text-slate-700 dark:text-slate-200">
            {value.visibility === "selected" ? "Share only with" : "Hide from"}
          </span>
          <MemberPicker
            selected={selectedProfiles}
            onChange={(next) => {
              setProfiles((prev) => [...prev.filter((p) => !next.some((n) => n.id === p.id)), ...next]);
              onChange({ visibility: value.visibility, userIds: next.map((p) => p.id) });
            }}
          />
        </div>
      )}
      <p className="text-xs text-slate-400">
        Enforced by the server: people outside this list can't load your status, even through the API. Statuses disappear after 24
        hours.
      </p>
    </fieldset>
  );
}
