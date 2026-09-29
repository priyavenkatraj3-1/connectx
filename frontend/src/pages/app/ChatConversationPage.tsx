import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { CallButtons } from "../../components/calls/CallButtons";
import { CallHistoryItem } from "../../components/calls/CallHistoryItem";
import { ConversationAIPanel } from "../../components/ai/ConversationAIPanel";
import { MessageAITools } from "../../components/ai/MessageAITools";
import { MessageBubble } from "../../components/chat/MessageBubble";
import { MessageComposer, type MentionCandidate } from "../../components/chat/MessageComposer";
import { MessageMenu } from "../../components/chat/MessageMenu";
import { OutboxBubbles } from "../../components/chat/OutboxBubbles";
import { ConversationToolsPanel } from "../../components/collaboration/ConversationToolsPanel";
import { ErrorState } from "../../components/common/ErrorState";
import { LoadingState } from "../../components/common/LoadingState";
import { GroupDetailsPanel } from "../../components/groups/GroupDetailsPanel";
import { ItemFormModal, type ItemKind } from "../../components/productivity/ItemFormModal";
import { Avatar } from "../../components/ui/Avatar";
import { BackIcon, BookmarkIcon, InfoIcon, NoteIcon, PhoneIcon, PinIcon, SparkleIcon, StarIcon, VideoIcon } from "../../components/ui/icons";
import { useOptionalAI } from "../../context/AIContext";
import { useAuth } from "../../context/AuthContext";
import { useOptionalCalls } from "../../context/CallContext";
import { useConversations } from "../../context/ConversationsContext";
import { useOptionalOffline } from "../../context/OfflineContext";
import { useRealtime } from "../../context/RealtimeContext";
import { useOptionalWorkspace } from "../../context/WorkspaceContext";
import { useMessageOrganization } from "../../hooks/useMessageOrganization";
import { useSafetyScan } from "../../hooks/useSafetyScan";
import { isNetworkError } from "../../services/apiClient";
import { callService } from "../../services/callService";
import { groupService } from "../../services/groupService";
import { messageService } from "../../services/messageService";
import { scheduledMessageService } from "../../services/productivityService";
import { isLiveCall, type CallDTO, type CallHistoryEntryDTO } from "../../types/call";
import type { GroupDetails } from "../../types/group";
import type { MessageDTO } from "../../types/message";
import { getConversationAvatarUrl, getConversationTitle } from "../../utils/conversationDisplay";

export function ChatConversationPage() {
  const { conversationId } = useParams<{ conversationId: string }>();
  const { accessToken, user } = useAuth();
  const { getConversation, markConversationRead, removeConversation, isLoading: conversationsLoading } = useConversations();
  const { subscribe } = useRealtime();
  const navigate = useNavigate();

  const [messages, setMessages] = useState<MessageDTO[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [replyingTo, setReplyingTo] = useState<MessageDTO | null>(null);
  const [editing, setEditing] = useState<MessageDTO | null>(null);
  const [groupDetails, setGroupDetails] = useState<GroupDetails | null>(null);
  const [isGroupPanelOpen, setIsGroupPanelOpen] = useState(false);
  const [removedReason, setRemovedReason] = useState<"removed" | "left" | null>(null);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [callHistory, setCallHistory] = useState<CallHistoryEntryDTO[]>([]);
  const [activeGroupCall, setActiveGroupCall] = useState<CallDTO | null>(null);
  const [isAIPanelOpen, setIsAIPanelOpen] = useState(false);
  const [isToolsPanelOpen, setIsToolsPanelOpen] = useState(false);
  const [creating, setCreating] = useState<{ kind: ItemKind; message: MessageDTO } | null>(null);
  const [showingCachedMessages, setShowingCachedMessages] = useState(false);
  const scrollAnchorRef = useRef<HTMLDivElement>(null);
  const calls = useOptionalCalls();
  const ai = useOptionalAI();
  // Phase 6 — all optional, so the page still renders on its own (e.g. in tests).
  const workspace = useOptionalWorkspace();
  const offline = useOptionalOffline();
  const organization = useMessageOrganization(conversationId, !!workspace);
  const { findings: safetyFindings, markHandled: markFindingHandled } = useSafetyScan(conversationId, messages, user?.id);
  const offlineCache = offline?.cache ?? null;
  const [reloadKey, setReloadKey] = useState(0);

  const conversation = conversationId ? getConversation(conversationId) : undefined;
  const isGroup = conversation?.type === "group";
  const groupId = conversation?.group?.id;

  // Reset per-conversation UI state when navigating between chats.
  useEffect(() => {
    setReplyingTo(null);
    setEditing(null);
    setRemovedReason(null);
    setIsGroupPanelOpen(false);
    setIsAIPanelOpen(false);
    setIsToolsPanelOpen(false);
    setCreating(null);
    setGroupDetails(null);
    setCallHistory([]);
    setActiveGroupCall(null);
  }, [conversationId]);

  useEffect(() => {
    if (!accessToken || !conversationId) return;
    let cancelled = false;

    setIsLoading(true);
    setError(null);
    setShowingCachedMessages(false);
    messageService
      .list(accessToken, conversationId)
      .then((page) => {
        if (!cancelled) {
          setMessages(page.items);
          setHasMoreHistory(page.hasMore);
        }
      })
      .catch(async (err) => {
        // Offline (Phase 6): show the recent messages saved on this device, clearly labelled.
        const cached = isNetworkError(err) ? await offlineCache?.loadMessages(conversationId) : null;
        if (cancelled) return;
        if (cached) {
          setMessages(cached.items);
          setHasMoreHistory(false);
          setShowingCachedMessages(true);
        } else {
          setError(err instanceof Error ? err.message : "Failed to load messages");
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [accessToken, conversationId, offlineCache, reloadKey]);

  // Keep this device's snapshot of the conversation current while online.
  useEffect(() => {
    if (!offlineCache || !conversationId || showingCachedMessages || isLoading || messages.length === 0) return;
    void offlineCache.saveMessages(conversationId, messages);
  }, [offlineCache, conversationId, messages, showingCachedMessages, isLoading]);

  // Back online after showing cached messages: load the real history.
  const isOnline = offline?.isOnline ?? true;
  useEffect(() => {
    if (isOnline && showingCachedMessages) setReloadKey((key) => key + 1);
  }, [isOnline, showingCachedMessages]);

  // A queued (offline) message was confirmed by the server — show the stored copy.
  useEffect(() => {
    if (!offline || !conversationId) return;
    return offline.subscribeSent((item, message) => {
      if (item.conversationId !== conversationId) return;
      setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]));
    });
  }, [offline, conversationId]);

  const loadGroupDetails = useCallback(async () => {
    if (!accessToken || !groupId) return;
    try {
      setGroupDetails(await groupService.get(accessToken, groupId));
    } catch {
      // Most likely we were just removed; the conversation:removed event handles the UI.
    }
  }, [accessToken, groupId]);

  useEffect(() => {
    void loadGroupDetails();
  }, [loadGroupDetails]);

  // Call history is shown inline in the timeline. Only enabled inside the
  // app shell (where calling exists); failures just mean no call entries.
  const loadCalls = useCallback(async () => {
    if (!accessToken || !conversationId || !calls) return;
    try {
      const history = await callService.history(accessToken, conversationId);
      setCallHistory(history);
      const live = history.find((entry) => entry.scope === "group" && isLiveCall(entry));
      setActiveGroupCall(live ?? (isGroup ? await callService.active(accessToken, conversationId) : null));
    } catch {
      setCallHistory([]);
    }
  }, [accessToken, conversationId, calls !== undefined, isGroup]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void loadCalls();
  }, [loadCalls]);

  useEffect(() => {
    if (!conversationId) return;

    return subscribe((event) => {
      if ("call" in event && event.call.conversationId === conversationId) {
        // Any call lifecycle change in this conversation: refresh the inline history / "join" banner.
        if (event.type !== "call:updated") void loadCalls();
        return;
      }
      if (!("conversationId" in event) || event.conversationId !== conversationId) return;

      switch (event.type) {
        case "message:new":
          setMessages((prev) => (prev.some((m) => m.id === event.message.id) ? prev : [...prev, event.message]));
          break;
        case "message:updated":
          setMessages((prev) => prev.map((m) => (m.id === event.message.id ? event.message : m)));
          break;
        case "message:deleted":
          setMessages((prev) =>
            prev
              .filter((m) => m.id !== event.messageId)
              .map((m) => (m.replyTo?.id === event.messageId ? { ...m, replyTo: { ...m.replyTo, body: null, deleted: true } } : m))
          );
          setReplyingTo((current) => (current?.id === event.messageId ? null : current));
          setEditing((current) => (current?.id === event.messageId ? null : current));
          break;
        case "message:delivered":
          setMessages((prev) =>
            prev.map((m) => (m.id === event.messageId && m.status === "sent" ? { ...m, status: "delivered" } : m))
          );
          break;
        case "message:read":
          setMessages((prev) => {
            const cutoffIndex = prev.findIndex((m) => m.id === event.upToMessageId);
            if (cutoffIndex === -1) return prev;
            return prev.map((m, index) => (index <= cutoffIndex && m.senderId === user?.id ? { ...m, status: "read" } : m));
          });
          break;
        case "message:status": {
          const ids = new Set(event.messageIds);
          setMessages((prev) =>
            prev.map((m) => (ids.has(m.id) && (event.status === "read" || m.status === "sent") ? { ...m, status: event.status } : m))
          );
          break;
        }
        case "conversation:removed":
          setRemovedReason(event.reason);
          setIsGroupPanelOpen(false);
          break;
        case "group:updated":
        case "group:member_added":
        case "group:member_removed":
        case "group:member_left":
        case "group:role_changed":
          void loadGroupDetails();
          break;
        default:
          break;
      }
    });
  }, [subscribe, conversationId, user?.id, loadGroupDetails, loadCalls]);

  // Mark newly-loaded/arrived messages as read while this conversation is open.
  useEffect(() => {
    if (!conversationId || messages.length === 0 || removedReason || showingCachedMessages) return;
    const lastMessage = messages[messages.length - 1]!;
    void markConversationRead(conversationId, lastMessage.id).catch(() => undefined);
  }, [conversationId, messages, markConversationRead, removedReason, showingCachedMessages]);

  useEffect(() => {
    scrollAnchorRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, callHistory.length]);

  const handleSent = useCallback((sent: MessageDTO) => {
    setMessages((prev) => (prev.some((m) => m.id === sent.id) ? prev : [...prev, sent]));
  }, []);

  const handleEdited = useCallback((updated: MessageDTO) => {
    setMessages((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
  }, []);

  const handleDelete = useCallback(
    async (message: MessageDTO) => {
      if (!accessToken || !conversationId) return;
      await messageService.remove(accessToken, conversationId, message.id);
      setMessages((prev) => prev.filter((m) => m.id !== message.id));
    },
    [accessToken, conversationId]
  );

  const handleLeft = useCallback(() => {
    if (!conversationId) return;
    removeConversation(conversationId);
    navigate("/app");
  }, [conversationId, removeConversation, navigate]);

  // Messages and calls interleaved by time. While older messages remain
  // unloaded, calls older than the oldest loaded message are held back too,
  // so they don't appear out of place above the loaded history.
  const timeline = useMemo(() => {
    const oldestLoaded = hasMoreHistory && messages[0] ? new Date(messages[0].createdAt).getTime() : -Infinity;
    const callItems = callHistory
      .filter((entry) => !isLiveCall(entry) && new Date(entry.createdAt).getTime() >= oldestLoaded)
      .map((entry) => ({ kind: "call" as const, at: new Date(entry.createdAt).getTime(), entry }));
    const messageItems = messages.map((message) => ({ kind: "message" as const, at: new Date(message.createdAt).getTime(), message }));
    return [...messageItems, ...callItems].sort((a, b) => a.at - b.at);
  }, [messages, callHistory, hasMoreHistory]);

  if (conversationsLoading && !conversation) {
    return <LoadingState label="Loading conversation…" />;
  }

  const title = conversation ? getConversationTitle(conversation) : "Conversation";
  const mentionCandidates: MentionCandidate[] =
    groupDetails?.members.filter((m) => m.userId !== user?.id).map((m) => ({ userId: m.userId, displayName: m.displayName })) ??
    [];
  const memberCount = groupDetails?.members.length ?? conversation?.group?.memberCount;
  const amInActiveGroupCall =
    !!activeGroupCall && activeGroupCall.participants.some((p) => p.userId === user?.id && p.state === "joined");

  // Phase 6: mirrors the server rule (the server enforces it) — anyone in a direct chat, owner/admins in a group.
  const canPin = !isGroup || groupDetails?.group.myRole === "owner" || groupDetails?.group.myRole === "admin";
  const conversationMembers =
    groupDetails?.members.map((m) => ({ userId: m.userId, displayName: m.displayName })) ??
    (conversation?.otherParticipant ? [{ userId: conversation.otherParticipant.id, displayName: conversation.otherParticipant.displayName }] : []);
  const isFocused = !!conversationId && !!workspace?.focusedConversationIds.includes(conversationId);
  const outboxItems = offline && conversationId ? offline.outbox.filter((item) => item.conversationId === conversationId) : [];
  const jumpToMessage = (messageId: string) => {
    document.querySelector(`[data-message-id="${messageId}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  };
  const scheduleMessage =
    workspace && accessToken && conversationId
      ? async (body: string, whenLocal: string) => {
          await scheduledMessageService.create(accessToken, { conversationId, body, scheduledForLocal: whenLocal, timezone: workspace.timezone });
        }
      : undefined;

  return (
    <div className="flex flex-1 overflow-hidden">
      <div className={`flex flex-1 flex-col ${isGroupPanelOpen || isAIPanelOpen || isToolsPanelOpen ? "hidden md:flex" : "flex"}`}>
        <header className="flex items-center gap-3 border-b border-slate-200 px-5 py-3 dark:border-slate-800">
          <Link
            to="/app"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800 md:hidden"
            aria-label="Back to chats"
          >
            <BackIcon />
          </Link>
          <Avatar name={title} imageUrl={conversation ? getConversationAvatarUrl(conversation) : undefined} size="sm" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</p>
            {isGroup && memberCount !== undefined && (
              <p className="truncate text-xs text-slate-400">
                {memberCount} {memberCount === 1 ? "member" : "members"}
              </p>
            )}
            {!isGroup && conversation?.otherParticipant?.statusMessage && (
              <p className="truncate text-xs text-slate-400">{conversation.otherParticipant.statusMessage}</p>
            )}
          </div>
          {calls && conversationId && !removedReason && (conversation?.type === "direct" || conversation?.type === "group") && (
            <CallButtons conversationId={conversationId} disabled={!!activeGroupCall} />
          )}
          {workspace && conversationId && !removedReason && (
            <>
              <button
                type="button"
                onClick={() => void workspace.setFocused(conversationId, !isFocused).catch(() => undefined)}
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 ${isFocused ? "text-amber-500" : "text-slate-500 dark:text-slate-400"}`}
                aria-label={isFocused ? "Remove from focused conversations" : "Mark as focused conversation"}
                aria-pressed={isFocused}
                title="Focused conversations appear first in Productivity Mode"
              >
                <StarIcon fill={isFocused ? "currentColor" : "none"} />
              </button>
              <button
                type="button"
                onClick={() => {
                  setIsGroupPanelOpen(false);
                  setIsAIPanelOpen(false);
                  setIsToolsPanelOpen((open) => !open);
                }}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
                aria-label="Chat tools"
                aria-expanded={isToolsPanelOpen}
                title="Pinned messages, shared notes, to-do lists, tasks and scheduled messages"
              >
                <NoteIcon />
              </button>
            </>
          )}
          {ai && conversationId && !removedReason && (
            <button
              type="button"
              onClick={() => {
                setIsGroupPanelOpen(false);
                setIsToolsPanelOpen(false);
                setIsAIPanelOpen((open) => !open);
              }}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
              aria-label="AI assistant"
              aria-expanded={isAIPanelOpen}
            >
              <SparkleIcon />
            </button>
          )}
          {isGroup && groupDetails && !removedReason && (
            <button
              type="button"
              onClick={() => {
                setIsAIPanelOpen(false);
                setIsToolsPanelOpen(false);
                setIsGroupPanelOpen((open) => !open);
              }}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
              aria-label="Group info"
              aria-expanded={isGroupPanelOpen}
            >
              <InfoIcon />
            </button>
          )}
        </header>

        {calls && activeGroupCall && !amInActiveGroupCall && !removedReason && (
          <div className="flex items-center gap-3 border-b border-emerald-200 bg-emerald-50 px-5 py-2 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
            {activeGroupCall.media === "video" ? <VideoIcon width={16} height={16} /> : <PhoneIcon width={16} height={16} />}
            <span className="flex-1">
              {activeGroupCall.media === "video" ? "Video" : "Voice"} call in progress ·{" "}
              {activeGroupCall.participants.filter((p) => p.state === "joined").length} joined
            </span>
            <button
              type="button"
              onClick={() => void calls.joinCall(activeGroupCall)}
              disabled={calls.isBusy}
              className="rounded-lg bg-emerald-600 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              Join
            </button>
          </div>
        )}

        <div className="flex flex-1 flex-col overflow-y-auto px-5 py-4">
          {showingCachedMessages && (
            <p role="status" className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
              You’re offline. Showing the recent messages saved on this device — they may be out of date.
            </p>
          )}
          {isLoading && <LoadingState label="Loading messages…" />}
          {!isLoading && error && <ErrorState message={error} />}

          {!isLoading && !error && timeline.length === 0 && (
            <div className="flex flex-1 items-center justify-center text-sm text-slate-400">
              {isGroup ? "No messages yet. Start the conversation!" : "No messages yet. Say hello!"}
            </div>
          )}

          {!isLoading &&
            !error &&
            timeline.map((item) =>
              item.kind === "call" ? (
                <CallHistoryItem key={`call-${item.entry.id}`} entry={item.entry} />
              ) : (
                <MessageBubble
                key={item.message.id}
                message={item.message}
                isOwn={item.message.senderId === user?.id}
                showSenderName={isGroup}
                currentUserId={user?.id}
                onReply={(m) => {
                  setEditing(null);
                  setReplyingTo(m);
                }}
                onEdit={(m) => {
                  setReplyingTo(null);
                  setEditing(m);
                }}
                onDelete={handleDelete}
                aiSlot={
                  ai ? (
                    <MessageAITools
                      message={item.message}
                      isOwn={item.message.senderId === user?.id}
                      finding={safetyFindings.get(item.message.id)}
                      onFindingHandled={markFindingHandled}
                    />
                  ) : undefined
                }
                badges={
                  workspace && (organization.pinnedIds.has(item.message.id) || organization.saved.has(item.message.id)) ? (
                    <>
                      {organization.pinnedIds.has(item.message.id) && <PinIcon width={11} height={11} aria-label="Pinned" />}
                      {organization.saved.get(item.message.id)?.starred ? (
                        <StarIcon width={11} height={11} fill="currentColor" aria-label="Starred" />
                      ) : (
                        organization.saved.has(item.message.id) && <BookmarkIcon width={11} height={11} aria-label="Saved" />
                      )}
                    </>
                  ) : undefined
                }
                extraActions={
                  workspace && !removedReason && !showingCachedMessages ? (
                    <MessageMenu
                      isPinned={organization.pinnedIds.has(item.message.id)}
                      canPin={canPin}
                      isSaved={organization.saved.has(item.message.id)}
                      isStarred={organization.saved.get(item.message.id)?.starred ?? false}
                      onTogglePin={() => organization.togglePin(item.message.id)}
                      onToggleSave={() => organization.toggleSave(item.message.id)}
                      onToggleStar={() => organization.toggleStar(item.message.id)}
                      onCreate={(kind) => setCreating({ kind, message: item.message })}
                    />
                  ) : undefined
                }
              />
              )
            )}
          {offline && (
            <OutboxBubbles
              items={outboxItems}
              onRetry={(id) => void offline.retry(id)}
              onDiscard={(id) => void offline.discard(id)}
            />
          )}
          <div ref={scrollAnchorRef} />
        </div>

        {removedReason ? (
          <p className="border-t border-slate-200 p-4 text-center text-sm text-slate-500 dark:border-slate-800">
            {removedReason === "left"
              ? "You left this group."
              : "You were removed from this group and can no longer send messages."}
          </p>
        ) : (
          conversationId && (
            <MessageComposer
              conversationId={conversationId}
              mentionCandidates={mentionCandidates}
              replyingTo={replyingTo}
              onCancelReply={() => setReplyingTo(null)}
              editing={editing}
              onCancelEdit={() => setEditing(null)}
              onSent={handleSent}
              onEdited={handleEdited}
              quickReplies={workspace?.quickReplies}
              onSchedule={scheduleMessage}
              offlineQueue={
                offline
                  ? { isOnline: offline.isOnline, queue: (input) => offline.queueMessage({ ...input, conversationId }) }
                  : undefined
              }
            />
          )
        )}
      </div>

      {isGroupPanelOpen && groupDetails && (
        <GroupDetailsPanel
          details={groupDetails}
          onChange={setGroupDetails}
          onLeft={handleLeft}
          onClose={() => setIsGroupPanelOpen(false)}
        />
      )}

      {isAIPanelOpen && ai && conversationId && !removedReason && (
        <ConversationAIPanel conversationId={conversationId} isGroup={isGroup} onClose={() => setIsAIPanelOpen(false)} />
      )}

      {isToolsPanelOpen && workspace && conversationId && !removedReason && (
        <ConversationToolsPanel
          key={conversationId}
          conversationId={conversationId}
          isGroup={isGroup}
          canPin={canPin}
          members={conversationMembers}
          onJumpToMessage={jumpToMessage}
          onClose={() => setIsToolsPanelOpen(false)}
        />
      )}

      {creating && conversationId && (
        <ItemFormModal
          kind={creating.kind}
          initial={{ title: (creating.message.body ?? "").slice(0, 200) }}
          source={{ sourceMessageId: creating.message.id }}
          assignees={creating.kind === "task" ? conversationMembers.filter((m) => m.userId !== user?.id) : []}
          onClose={() => setCreating(null)}
        />
      )}
    </div>
  );
}
