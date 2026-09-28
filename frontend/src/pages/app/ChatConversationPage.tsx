import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { CallButtons } from "../../components/calls/CallButtons";
import { CallHistoryItem } from "../../components/calls/CallHistoryItem";
import { MessageBubble } from "../../components/chat/MessageBubble";
import { MessageComposer, type MentionCandidate } from "../../components/chat/MessageComposer";
import { ErrorState } from "../../components/common/ErrorState";
import { LoadingState } from "../../components/common/LoadingState";
import { GroupDetailsPanel } from "../../components/groups/GroupDetailsPanel";
import { Avatar } from "../../components/ui/Avatar";
import { BackIcon, InfoIcon, PhoneIcon, VideoIcon } from "../../components/ui/icons";
import { useAuth } from "../../context/AuthContext";
import { useOptionalCalls } from "../../context/CallContext";
import { useConversations } from "../../context/ConversationsContext";
import { useRealtime } from "../../context/RealtimeContext";
import { callService } from "../../services/callService";
import { groupService } from "../../services/groupService";
import { messageService } from "../../services/messageService";
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
  const scrollAnchorRef = useRef<HTMLDivElement>(null);
  const calls = useOptionalCalls();

  const conversation = conversationId ? getConversation(conversationId) : undefined;
  const isGroup = conversation?.type === "group";
  const groupId = conversation?.group?.id;

  // Reset per-conversation UI state when navigating between chats.
  useEffect(() => {
    setReplyingTo(null);
    setEditing(null);
    setRemovedReason(null);
    setIsGroupPanelOpen(false);
    setGroupDetails(null);
    setCallHistory([]);
    setActiveGroupCall(null);
  }, [conversationId]);

  useEffect(() => {
    if (!accessToken || !conversationId) return;
    let cancelled = false;

    setIsLoading(true);
    setError(null);
    messageService
      .list(accessToken, conversationId)
      .then((page) => {
        if (!cancelled) {
          setMessages(page.items);
          setHasMoreHistory(page.hasMore);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load messages");
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [accessToken, conversationId]);

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
    if (!conversationId || messages.length === 0 || removedReason) return;
    const lastMessage = messages[messages.length - 1]!;
    void markConversationRead(conversationId, lastMessage.id).catch(() => undefined);
  }, [conversationId, messages, markConversationRead, removedReason]);

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

  return (
    <div className="flex flex-1 overflow-hidden">
      <div className={`flex flex-1 flex-col ${isGroupPanelOpen ? "hidden md:flex" : "flex"}`}>
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
          {isGroup && groupDetails && !removedReason && (
            <button
              type="button"
              onClick={() => setIsGroupPanelOpen((open) => !open)}
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
              />
              )
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
    </div>
  );
}
