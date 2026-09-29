import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../context/AuthContext";
import { useRealtime } from "../../context/RealtimeContext";
import { useWorkspace } from "../../context/WorkspaceContext";
import { sessionService } from "../../services/productivityService";
import type { DeviceSession, UserPreferences } from "../../types/productivity";
import { browserTimezone, formatDateTime } from "../../utils/datetime";
import { ErrorLine, fieldClass } from "../productivity/shared";
import { Button } from "../ui/Button";

function supportedTimezones(): string[] {
  try {
    const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
    return intl.supportedValuesOf?.("timeZone") ?? [browserTimezone(), "UTC"];
  } catch {
    return [browserTimezone(), "UTC"];
  }
}

function Toggle({ label, description, checked, onChange }: { label: string; description: string; checked: boolean; onChange(value: boolean): void }) {
  return (
    <label className="flex items-center justify-between gap-4 border-b border-slate-100 py-3 last:border-0 dark:border-slate-800">
      <span>
        <span className="block text-sm font-medium text-slate-900 dark:text-slate-100">{label}</span>
        <span className="block text-sm text-slate-500 dark:text-slate-400">{description}</span>
      </span>
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-label={label} />
    </label>
  );
}

function usePreferenceUpdater() {
  const { preferences, updatePreferences } = useWorkspace();
  const [error, setError] = useState<string | null>(null);
  const update = (change: Partial<Omit<UserPreferences, "updatedAt">>) => {
    setError(null);
    updatePreferences(change).catch((err: unknown) => setError(err instanceof Error ? err.message : "Couldn't save"));
  };
  return { preferences, update, error };
}

/** Settings → Productivity: Productivity Mode and the timezone used for tasks, reminders and scheduling. */
export function ProductivitySettings() {
  const { preferences, update, error } = usePreferenceUpdater();
  if (!preferences) return <p className="text-sm text-slate-500">Loading…</p>;
  const zones = supportedTimezones();
  const current = preferences.timezone ?? "";
  return (
    <div>
      <Toggle
        label="Productivity Mode"
        description="Group your chat list into focused, unread and everything else. Nothing is hidden; switch off any time."
        checked={preferences.productivityMode}
        onChange={(value) => update({ productivityMode: value })}
      />
      <div className="py-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-slate-900 dark:text-slate-100">Timezone</span>
          <span className="text-slate-500 dark:text-slate-400">Used to read the times you enter for tasks, reminders, events and scheduled messages.</span>
          <select value={current} onChange={(e) => update({ timezone: e.target.value || null })} className={`${fieldClass} mt-1`} aria-label="Timezone">
            <option value="">Use this device’s timezone ({browserTimezone()})</option>
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ErrorLine message={error} />
    </div>
  );
}

/** Settings → Notifications: which in-app notifications to create. */
export function NotificationSettings() {
  const { preferences, update, error } = usePreferenceUpdater();
  if (!preferences) return <p className="text-sm text-slate-500">Loading…</p>;
  return (
    <div>
      <p className="mb-2 text-sm text-slate-500 dark:text-slate-400">
        Notifications appear in the bell in the sidebar on every signed-in device. ConnectX doesn’t send push or email notifications yet.
      </p>
      <Toggle label="Mentions" description="When someone @mentions you in a group" checked={preferences.notifyMentions} onChange={(v) => update({ notifyMentions: v })} />
      <Toggle label="Task due" description="When one of your tasks reaches its due time" checked={preferences.notifyTaskDue} onChange={(v) => update({ notifyTaskDue: v })} />
      <Toggle label="Reminders" description="When a reminder you set goes off" checked={preferences.notifyReminders} onChange={(v) => update({ notifyReminders: v })} />
      <Toggle label="Assignments" description="When someone assigns you a task or to-do item" checked={preferences.notifyAssignments} onChange={(v) => update({ notifyAssignments: v })} />
      <Toggle
        label="Scheduled messages"
        description="When a message you scheduled is sent, or couldn’t be sent"
        checked={preferences.notifyScheduledMessages}
        onChange={(v) => update({ notifyScheduledMessages: v })}
      />
      <p className="mt-2 text-xs text-slate-400">New sign-ins to your account are always notified.</p>
      <ErrorLine message={error} />
    </div>
  );
}

/** Settings → Devices: every signed-in device (session), with rename and sign-out. */
export function DevicesSettings() {
  const { accessToken, sessionId } = useAuth();
  const { subscribe } = useRealtime();
  const [sessions, setSessions] = useState<DeviceSession[]>([]);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!accessToken) return;
    try {
      setSessions(await sessionService.list(accessToken));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load devices");
    }
  }, [accessToken]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => subscribe((event) => (event.type === "sessions:updated" ? void load() : undefined)), [subscribe, load]);

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    }
  }

  const others = sessions.filter((s) => !s.current && s.id !== sessionId);

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-500 dark:text-slate-400">
        Each sign-in is a separate session. Signing a device out ends its session immediately — it can’t make requests or receive messages until it signs in again.
      </p>
      <ErrorLine message={error} />
      <ul className="divide-y divide-slate-100 dark:divide-slate-800" aria-label="Signed-in devices">
        {sessions.map((session) => (
          <li key={session.id} className="flex items-center gap-3 py-3">
            <div className="min-w-0 flex-1">
              {renaming?.id === session.id ? (
                <div className="flex gap-2">
                  <input value={renaming.name} onChange={(e) => setRenaming({ id: session.id, name: e.target.value })} maxLength={120} className={fieldClass} aria-label="Device name" />
                  <Button className="py-1.5" disabled={!renaming.name.trim()} onClick={() => accessToken && void run(async () => { await sessionService.rename(accessToken, session.id, renaming.name.trim()); setRenaming(null); })}>
                    Save
                  </Button>
                </div>
              ) : (
                <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
                  {session.deviceName}
                  {session.current && <span className="ml-2 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-700">This device</span>}
                </p>
              )}
              <p className="text-xs text-slate-500">
                {session.userAgentSummary && session.userAgentSummary !== session.deviceName ? `${session.userAgentSummary} · ` : ""}
                Signed in {formatDateTime(session.createdAt)}
                {session.lastSeenAt && ` · last active ${formatDateTime(session.lastSeenAt)}`}
              </p>
            </div>
            <div className="flex shrink-0 gap-2 text-xs font-medium">
              <button type="button" className="text-slate-500" onClick={() => setRenaming({ id: session.id, name: session.deviceName })}>
                Rename
              </button>
              {!session.current && accessToken && (
                <button type="button" className="text-red-600" onClick={() => void run(() => sessionService.revoke(accessToken, session.id))}>
                  Sign out
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {others.length > 0 && accessToken && (
        <Button variant="secondary" onClick={() => void run(() => sessionService.revokeOthers(accessToken))}>
          Sign out all other devices
        </Button>
      )}
    </div>
  );
}
