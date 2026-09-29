import { useEffect, useState } from "react";
import { useAuth } from "../../context/AuthContext";
import { useEscapeKey } from "../../hooks/useEscapeKey";
import { statusService } from "../../services/statusService";
import type { StatusPrivacy } from "../../types/status";
import { LoadingState } from "../common/LoadingState";
import { Button } from "../ui/Button";
import { StatusPrivacyPicker } from "./StatusPrivacyPicker";

/** Edits the default privacy applied to new statuses. Existing statuses keep the privacy they were published with. */
export function StatusPrivacyModal({ onClose }: { onClose(): void }) {
  const { accessToken } = useAuth();
  const [privacy, setPrivacy] = useState<StatusPrivacy | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEscapeKey(onClose, !isSaving);

  useEffect(() => {
    if (!accessToken) return;
    statusService
      .getPrivacy(accessToken)
      .then(setPrivacy)
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't load your privacy settings"));
  }, [accessToken]);

  async function save() {
    if (!accessToken || !privacy) return;
    setIsSaving(true);
    setError(null);
    try {
      await statusService.updatePrivacy(accessToken, privacy);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save");
      setIsSaving(false);
    }
  }

  const invalid = privacy?.visibility === "selected" && privacy.userIds.length === 0;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:pt-12" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="status-privacy-title"
        onClick={(e) => e.stopPropagation()}
        className="flex w-full max-w-md flex-col rounded-xl2 bg-white shadow-xl dark:bg-surface-dark-subtle"
      >
        <div className="border-b border-slate-100 p-4 dark:border-slate-800">
          <h2 id="status-privacy-title" className="text-base font-semibold text-slate-900 dark:text-slate-100">
            Status privacy
          </h2>
          <p className="mt-1 text-xs text-slate-500">Applies to statuses you post from now on.</p>
        </div>
        <div className="p-4">
          {privacy ? <StatusPrivacyPicker value={privacy} onChange={setPrivacy} /> : !error && <LoadingState label="Loading…" />}
          {invalid && <p className="mt-2 text-sm text-amber-600">Choose at least one person.</p>}
          {error && (
            <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">
              {error}
            </p>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-100 p-4 dark:border-slate-800">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void save()} disabled={!privacy || invalid} isLoading={isSaving}>
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}
