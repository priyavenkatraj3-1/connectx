import { useEffect, useRef } from "react";
import { useAuth } from "../context/AuthContext";
import { useRealtime } from "../context/RealtimeContext";
import { userService } from "../services/userService";

/**
 * Keeps the signed-in user's name and picture (shown in the sidebar,
 * settings and status page) current: loaded once per sign-in — sign-in
 * responses don't include the picture — and updated live when you change
 * them on another device.
 */
export function useOwnProfileSync(): void {
  const { accessToken, user, updateUser } = useAuth();
  const { subscribe } = useRealtime();
  const syncedFor = useRef<string | null>(null);
  const userId = user?.id ?? null;

  useEffect(() => {
    if (!accessToken || !userId || syncedFor.current === userId) return;
    syncedFor.current = userId;
    userService
      .getMe(accessToken)
      .then((me) => updateUser({ displayName: me.displayName, avatarUrl: me.avatarUrl }))
      .catch(() => {
        syncedFor.current = null; // try again on the next token (e.g. after coming back online)
      });
  }, [accessToken, userId, updateUser]);

  useEffect(
    () =>
      subscribe((event) => {
        if (event.type === "user:updated" && event.user.id === userId) {
          updateUser({ displayName: event.user.displayName, avatarUrl: event.user.avatarUrl });
        }
      }),
    [subscribe, userId, updateUser]
  );
}
