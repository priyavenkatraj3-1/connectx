import { useEffect, useState } from "react";
import { useAuth } from "../context/AuthContext";
import { mediaService } from "../services/mediaService";

type State =
  | { status: "idle" | "loading"; url: null; error: null }
  | { status: "ready"; url: string; error: null }
  | { status: "error"; url: null; error: string };

/**
 * Loads an attachment through the authenticated API and exposes it as a
 * temporary object URL (revoked on unmount). Media endpoints require the
 * Authorization header, which plain <img>/<video> src URLs can't send.
 * Pass `enabled: false` to defer loading (e.g. documents load on click).
 */
export function useAttachmentUrl(attachmentId: string, enabled = true): State {
  const { accessToken } = useAuth();
  const [state, setState] = useState<State>({ status: "idle", url: null, error: null });

  useEffect(() => {
    if (!enabled || !accessToken) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    setState({ status: "loading", url: null, error: null });

    mediaService
      .fetchContent(accessToken, attachmentId)
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
  }, [accessToken, attachmentId, enabled]);

  return state;
}
