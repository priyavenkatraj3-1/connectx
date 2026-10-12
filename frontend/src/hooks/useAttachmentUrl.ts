import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../context/AuthContext";
import { ApiError, isSessionEndedCode } from "../services/apiClient";
import { mediaService } from "../services/mediaService";

type State =
  | { status: "idle" | "loading"; url: null; error: null }
  | { status: "ready"; url: string; error: null }
  | { status: "error"; url: null; error: string };

export type AttachmentUrlState = State & {
  /** Loads again after an error (e.g. the user clicks to retry). */
  reload(): void;
};

/**
 * Loads an attachment through the authenticated API and exposes it as a
 * temporary object URL (revoked on unmount). Media endpoints require the
 * Authorization header, which plain <img>/<video> src URLs can't send.
 * Pass `enabled: false` to defer loading (e.g. documents load on click).
 *
 * Always uses the latest access token. If the server rejects it as expired
 * (a plain 401, not an ended session), the token is refreshed through
 * AuthContext and the request retried once; any further rejection is shown
 * as an error.
 */
export function useAttachmentUrl(attachmentId: string, enabled = true): AttachmentUrlState {
  const { accessToken, refreshAccessToken } = useAuth();
  const [state, setState] = useState<State>({ status: "idle", url: null, error: null });
  const [attempt, setAttempt] = useState(0);
  // Read at request time so a refreshed token is used without re-fetching
  // (and revoking) media that already loaded with the previous one.
  const tokenRef = useRef(accessToken);
  tokenRef.current = accessToken;
  const hasToken = Boolean(accessToken);

  useEffect(() => {
    const token = tokenRef.current;
    if (!enabled) return;
    if (!token) {
      // Signed out (possibly mid-request, if the refresh was rejected): don't leave a spinner behind.
      setState((prev) => (prev.status === "idle" ? prev : { status: "error", url: null, error: "Please sign in again to open this file." }));
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    setState({ status: "loading", url: null, error: null });

    const load = async (): Promise<Blob> => {
      try {
        return await mediaService.fetchContent(token, attachmentId);
      } catch (err) {
        if (!(err instanceof ApiError) || err.status !== 401 || isSessionEndedCode(err.code)) throw err;
        const refreshed = await refreshAccessToken();
        if (!refreshed || cancelled) throw err;
        return mediaService.fetchContent(refreshed, attachmentId);
      }
    };

    load()
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ status: "ready", url: objectUrl, error: null });
      })
      .catch((err) => {
        if (!cancelled) setState({ status: "error", url: null, error: err instanceof Error ? err.message : "Couldn't load file" });
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [hasToken, attachmentId, enabled, attempt, refreshAccessToken]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...state, reload };
}
