import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "../../context/AuthContext";
import { useWorkspace } from "../../context/WorkspaceContext";
import { businessService, type BusinessProfileInput } from "../../services/productivityService";
import type { BusinessHours, BusinessProfile, QuickReply, Weekday } from "../../types/productivity";
import { ErrorLine, Field, fieldClass } from "../productivity/shared";
import { Button } from "../ui/Button";
import { TrashIcon } from "../ui/icons";

const DAYS: Array<{ id: Weekday; label: string }> = [
  { id: "mon", label: "Mon" },
  { id: "tue", label: "Tue" },
  { id: "wed", label: "Wed" },
  { id: "thu", label: "Thu" },
  { id: "fri", label: "Fri" },
  { id: "sat", label: "Sat" },
  { id: "sun", label: "Sun" },
];

const EMPTY: BusinessProfileInput = {
  businessName: "",
  description: null,
  category: null,
  website: null,
  contactEmail: null,
  contactPhone: null,
  address: null,
  businessHours: {},
  isPublic: true,
};

/**
 * Settings → Business: an optional business profile, kept separate from the
 * personal profile, plus quick-reply templates for the composer.
 * Verification is shown honestly: nothing verifies businesses yet.
 */
export function BusinessSettings() {
  const { accessToken } = useAuth();
  const [profile, setProfile] = useState<BusinessProfile | null>(null);
  const [form, setForm] = useState<BusinessProfileInput>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!accessToken) return;
    businessService.get(accessToken).then(
      (existing) => {
        setProfile(existing);
        if (existing) {
          const { userId: _u, verificationStatus: _v, createdAt: _c, updatedAt: _up, ...editable } = existing;
          setForm(editable);
        }
        setLoaded(true);
      },
      (err: unknown) => {
        setError(err instanceof Error ? err.message : "Couldn't load business profile");
        setLoaded(true);
      }
    );
  }, [accessToken]);

  const set = <K extends keyof BusinessProfileInput>(key: K, value: BusinessProfileInput[K]) => setForm((prev) => ({ ...prev, [key]: value }));
  const text = (key: "description" | "category" | "website" | "contactEmail" | "contactPhone" | "address") => ({
    value: form[key] ?? "",
    onChange: (e: { target: { value: string } }) => set(key, e.target.value.trim() === "" ? null : e.target.value),
  });

  function setHours(day: Weekday, open: string, close: string, enabled: boolean) {
    const hours: BusinessHours = { ...form.businessHours };
    if (enabled) hours[day] = [{ open, close }];
    else delete hours[day];
    set("businessHours", hours);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!accessToken) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      setProfile(await businessService.save(accessToken, { ...form, businessName: form.businessName.trim() }));
      setMessage("Business profile saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!accessToken) return;
    try {
      await businessService.remove(accessToken);
      setProfile(null);
      setForm(EMPTY);
      setMessage("Business profile removed.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't remove");
    }
  }

  if (!loaded) return <p className="text-sm text-slate-500">Loading…</p>;

  return (
    <div className="space-y-8">
      <form onSubmit={save} className="space-y-3" aria-label="Business profile">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          A business profile sits alongside your personal profile — your name, photo and bio don’t change.
        </p>
        {profile && (
          <p className="text-xs text-slate-500">
            Verification: <span className="font-semibold">Not verified</span> — ConnectX doesn’t verify businesses yet, so no profile shows a verified badge.
          </p>
        )}
        <Field label="Business name">
          <input value={form.businessName} onChange={(e) => set("businessName", e.target.value)} maxLength={120} className={fieldClass} required />
        </Field>
        <Field label="Description">
          <textarea {...text("description")} rows={3} maxLength={1000} className={fieldClass} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Category">
            <input {...text("category")} maxLength={60} className={fieldClass} placeholder="e.g. Bakery" />
          </Field>
          <Field label="Website">
            <input {...text("website")} maxLength={300} className={fieldClass} placeholder="https://" />
          </Field>
          <Field label="Contact email">
            <input {...text("contactEmail")} type="email" maxLength={254} className={fieldClass} />
          </Field>
          <Field label="Contact phone">
            <input {...text("contactPhone")} maxLength={32} className={fieldClass} />
          </Field>
        </div>
        <Field label="Address">
          <input {...text("address")} maxLength={300} className={fieldClass} />
        </Field>
        <fieldset className="space-y-1">
          <legend className="text-sm font-medium text-slate-700 dark:text-slate-200">Business hours</legend>
          {DAYS.map((day) => {
            const interval = form.businessHours[day.id]?.[0];
            return (
              <div key={day.id} className="flex items-center gap-2 text-sm">
                <label className="flex w-20 items-center gap-2">
                  <input type="checkbox" checked={!!interval} onChange={(e) => setHours(day.id, interval?.open ?? "09:00", interval?.close ?? "17:00", e.target.checked)} />
                  {day.label}
                </label>
                {interval ? (
                  <>
                    <input type="time" value={interval.open} onChange={(e) => setHours(day.id, e.target.value, interval.close, true)} className={`${fieldClass} w-auto py-1`} aria-label={`${day.label} opens`} />
                    <span>–</span>
                    <input type="time" value={interval.close} onChange={(e) => setHours(day.id, interval.open, e.target.value, true)} className={`${fieldClass} w-auto py-1`} aria-label={`${day.label} closes`} />
                  </>
                ) : (
                  <span className="text-slate-400">Closed</span>
                )}
              </div>
            );
          })}
        </fieldset>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.isPublic} onChange={(e) => set("isPublic", e.target.checked)} />
          Let other ConnectX users view this business profile
        </label>
        <ErrorLine message={error} />
        {message && <p className="text-xs text-emerald-600">{message}</p>}
        <div className="flex gap-2">
          <Button type="submit" isLoading={saving} disabled={!form.businessName.trim()}>
            {profile ? "Save changes" : "Create business profile"}
          </Button>
          {profile && (
            <Button type="button" variant="ghost" className="text-red-600" onClick={() => void remove()}>
              Remove business profile
            </Button>
          )}
        </div>
      </form>

      {profile && <QuickReplySettings />}
    </div>
  );
}

function QuickReplySettings() {
  const { accessToken } = useAuth();
  const { quickReplies } = useWorkspace();
  const [draft, setDraft] = useState({ shortcut: "", title: "", body: "" });
  const [editing, setEditing] = useState<QuickReply | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    }
  }

  const active = editing ?? draft;
  const setActive = (change: Partial<typeof draft>) => (editing ? setEditing({ ...editing, ...change }) : setDraft({ ...draft, ...change }));

  return (
    <section className="space-y-3" aria-label="Quick replies">
      <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">Quick replies</h3>
      <p className="text-sm text-slate-500 dark:text-slate-400">Saved answers you can insert into any chat with the ⚡ button or by typing their shortcut.</p>
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {quickReplies.map((reply) => (
          <li key={reply.id} className="flex items-start gap-2 py-2">
            <div className="min-w-0 flex-1">
              <p className="text-sm">
                <span className="font-mono text-xs text-brand-600">{reply.shortcut}</span> <span className="font-medium">{reply.title}</span>
              </p>
              <p className="whitespace-pre-wrap text-xs text-slate-500">{reply.body}</p>
            </div>
            <button type="button" className="text-xs text-slate-500" onClick={() => setEditing(reply)}>
              Edit
            </button>
            <button type="button" className="text-slate-400 hover:text-red-600" aria-label={`Delete quick reply ${reply.shortcut}`} onClick={() => accessToken && void run(() => businessService.removeQuickReply(accessToken, reply.id))}>
              <TrashIcon width={14} height={14} />
            </button>
          </li>
        ))}
      </ul>
      <form
        className="space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-700"
        onSubmit={(e) => {
          e.preventDefault();
          if (!accessToken) return;
          void run(async () => {
            if (editing) {
              await businessService.updateQuickReply(accessToken, editing.id, { shortcut: editing.shortcut, title: editing.title, body: editing.body });
              setEditing(null);
            } else {
              await businessService.createQuickReply(accessToken, draft);
              setDraft({ shortcut: "", title: "", body: "" });
            }
          });
        }}
      >
        <p className="text-xs font-semibold text-slate-600 dark:text-slate-300">{editing ? "Edit quick reply" : "New quick reply"}</p>
        <div className="flex gap-2">
          <input value={active.shortcut} onChange={(e) => setActive({ shortcut: e.target.value })} placeholder="/hours" maxLength={32} className={`${fieldClass} w-32`} aria-label="Shortcut" />
          <input value={active.title} onChange={(e) => setActive({ title: e.target.value })} placeholder="Title" maxLength={80} className={fieldClass} aria-label="Quick reply title" />
        </div>
        <textarea value={active.body} onChange={(e) => setActive({ body: e.target.value })} placeholder="Message text" rows={3} maxLength={2000} className={fieldClass} aria-label="Quick reply text" />
        <ErrorLine message={error} />
        <div className="flex gap-2">
          <Button type="submit" className="py-1.5" disabled={!active.shortcut.trim() || !active.title.trim() || !active.body.trim()}>
            {editing ? "Save" : "Add quick reply"}
          </Button>
          {editing && (
            <Button type="button" variant="ghost" className="py-1.5" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          )}
        </div>
      </form>
    </section>
  );
}
