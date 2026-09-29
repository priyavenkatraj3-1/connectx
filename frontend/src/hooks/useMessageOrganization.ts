import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../context/AuthContext";
import { useRealtime } from "../context/RealtimeContext";
import { pinService, savedService } from "../services/productivityService";

/**
 * Pinned / saved / starred state of the messages in one conversation, kept
 * in sync by realtime events (pins are shared with the conversation; saves
 * are private and sync across your own devices). Disabled (no requests)
 * when `enabled` is false — e.g. outside the app shell.
 */
export function useMessageOrganization(conversationId: string | undefined, enabled: boolean) {
  const { accessToken } = useAuth();
  const { subscribe } = useRealtime();
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set());
  const [saved, setSaved] = useState<Map<string, { starred: boolean }>>(new Map());

  const load = useCallback(async () => {
    if (!enabled || !accessToken || !conversationId) return;
    try {
      const [pins, savedItems] = await Promise.all([
        pinService.list(accessToken, conversationId),
        savedService.inConversation(accessToken, conversationId),
      ]);
      setPinnedIds(new Set(pins.map((pin) => pin.messageId)));
      setSaved(new Map(savedItems.map((item) => [item.messageId, { starred: item.starred }])));
    } catch {
      // Markers are a convenience; the chat works without them.
    }
  }, [enabled, accessToken, conversationId]);

  useEffect(() => {
    setPinnedIds(new Set());
    setSaved(new Map());
    void load();
  }, [load]);

  useEffect(() => {
    if (!enabled || !conversationId) return;
    return subscribe((event) => {
      if (event.type === "message:pinned" && event.conversationId === conversationId) {
        setPinnedIds((prev) => new Set(prev).add(event.pin.messageId));
      } else if (event.type === "message:unpinned" && event.conversationId === conversationId) {
        setPinnedIds((prev) => {
          const next = new Set(prev);
          next.delete(event.messageId);
          return next;
        });
      } else if (event.type === "saved:updated") {
        setSaved((prev) => {
          const next = new Map(prev);
          if (event.saved && event.saved.conversationId === conversationId) next.set(event.messageId, { starred: event.saved.starred });
          else next.delete(event.messageId);
          return next;
        });
      }
    });
  }, [enabled, conversationId, subscribe]);

  const togglePin = useCallback(
    async (messageId: string) => {
      if (!accessToken) return;
      if (pinnedIds.has(messageId)) await pinService.unpin(accessToken, messageId);
      else await pinService.pin(accessToken, messageId);
      await load();
    },
    [accessToken, pinnedIds, load]
  );

  const toggleSave = useCallback(
    async (messageId: string) => {
      if (!accessToken) return;
      if (saved.has(messageId)) await savedService.unsave(accessToken, messageId);
      else await savedService.save(accessToken, messageId);
      await load();
    },
    [accessToken, saved, load]
  );

  const toggleStar = useCallback(
    async (messageId: string) => {
      if (!accessToken) return;
      await savedService.save(accessToken, messageId, { starred: !(saved.get(messageId)?.starred ?? false) });
      await load();
    },
    [accessToken, saved, load]
  );

  return { pinnedIds, saved, togglePin, toggleSave, toggleStar };
}
