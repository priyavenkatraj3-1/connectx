import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { MessageStatusTicks } from "../../components/chat/MessageStatusTicks";
import { ErrorState } from "../../components/common/ErrorState";
import { LoadingState } from "../../components/common/LoadingState";
import { Avatar } from "../../components/ui/Avatar";
import { Button } from "../../components/ui/Button";
import { BackIcon, SendIcon } from "../../components/ui/icons";
import { useAuth } from "../../context/AuthContext";
import { useConversations } from "../../context/ConversationsContext";
import { useRealtime } from "../../context/RealtimeContext";
import { messageService } from "../../services/messageService";
import type { MessageDTO } from "../../types/message";
import { formatMessageTime } from "../../utils/formatTime";

export function ChatConversationPage() {
  const { conversationId } = useParams<{ conversationId: string }>();
  const { accessToken, user } = useAuth();
  const { getConversation, markConversationRead, isLoading: conversationsLoading } = useConversations();
  const { subscribe } = useRealtime();

  const [messages, setMessages] = useState<MessageDTO[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [isSending, setIsSending] = useState(false);
  const scrollAnchorRef = useRef<HTMLDivElement>(null);

  const conversation = conversationId ? getConversation(conversationId) : undefined;

  useEffect(() => {
    if (!accessToken || !conversationId) return;
    let cancelled = false;

    setIsLoading(true);
    setError(null);
    messageService
      .list(accessToken, conversationId)
      .then((page) => {
        if (!cancelled) setMessages(page.items);
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

  useEffect(() => {
    if (!conversationId) return;

    return subscribe((event) => {
      if (event.type === "error" || event.conversationId !== conversationId) return;

      if (event.type === "message:new") {
        setMessages((prev) => (prev.some((m) => m.id === event.message.id) ? prev : [...prev, event.message]));
      } else if (event.type === "message:delivered") {
        setMessages((prev) =>
          prev.map((m) => (m.id === event.messageId && m.status === "sent" ? { ...m, status: "delivered" } : m))
        );
      } else if (event.type === "message:read") {
        setMessages((prev) => {
          const cutoffIndex = prev.findIndex((m) => m.id === event.upToMessageId);
          if (cutoffIndex === -1) return prev;
          return prev.map((m, index) =>
            index <= cutoffIndex && m.senderId === user?.id ? { ...m, status: "read" } : m
          );
        });
      }
    });
  }, [subscribe, conversationId, user?.id]);

  // Mark newly-loaded/arrived messages as read while this conversation is open.
  useEffect(() => {
    if (!conversationId || messages.length === 0) return;
    const lastMessage = messages[messages.length - 1]!;
    void markConversationRead(conversationId, lastMessage.id);
  }, [conversationId, messages, markConversationRead]);

  useEffect(() => {
    scrollAnchorRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length]);

  async function sendDraft() {
    const body = draft.trim();
    if (!body || !accessToken || !conversationId || isSending) return;

    setIsSending(true);
    setDraft("");
    try {
      const sent = await messageService.send(accessToken, conversationId, body);
      setMessages((prev) => (prev.some((m) => m.id === sent.id) ? prev : [...prev, sent]));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send message");
      setDraft(body);
    } finally {
      setIsSending(false);
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    void sendDraft();
  }

  if (conversationsLoading && !conversation) {
    return <LoadingState label="Loading conversation…" />;
  }

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-slate-200 px-5 py-3 dark:border-slate-800">
        <Link
          to="/app"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800 md:hidden"
          aria-label="Back to chats"
        >
          <BackIcon />
        </Link>
        <Avatar
          name={conversation?.otherParticipant.displayName ?? "?"}
          imageUrl={conversation?.otherParticipant.avatarUrl ?? undefined}
          size="sm"
        />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
            {conversation?.otherParticipant.displayName ?? "Conversation"}
          </p>
          {conversation?.otherParticipant.statusMessage && (
            <p className="truncate text-xs text-slate-400">{conversation.otherParticipant.statusMessage}</p>
          )}
        </div>
      </header>

      <div className="flex flex-1 flex-col overflow-y-auto px-5 py-4">
        {isLoading && <LoadingState label="Loading messages…" />}
        {!isLoading && error && <ErrorState message={error} />}

        {!isLoading && !error && messages.length === 0 && (
          <div className="flex flex-1 items-center justify-center text-sm text-slate-400">
            No messages yet. Say hello!
          </div>
        )}

        {!isLoading &&
          !error &&
          messages.map((message) => {
            const isOwn = message.senderId === user?.id;
            return (
              <div key={message.id} className={`mb-2 flex ${isOwn ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[75%] rounded-2xl px-4 py-2 text-sm ${
                    isOwn
                      ? "bg-brand-600 text-white"
                      : "border border-slate-200 bg-white text-slate-900 dark:border-slate-700 dark:bg-surface-dark-subtle dark:text-slate-100"
                  }`}
                >
                  <p className="whitespace-pre-wrap break-words">{message.body}</p>
                  <div
                    className={`mt-1 flex items-center justify-end gap-1 text-[11px] ${
                      isOwn ? "text-white/70" : "text-slate-400"
                    }`}
                  >
                    <span>{formatMessageTime(message.createdAt)}</span>
                    {isOwn && <MessageStatusTicks status={message.status} />}
                  </div>
                </div>
              </div>
            );
          })}
        <div ref={scrollAnchorRef} />
      </div>

      <form onSubmit={handleSubmit} className="flex items-end gap-2 border-t border-slate-200 p-3 dark:border-slate-800">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void sendDraft();
            }
          }}
          rows={1}
          placeholder="Type a message"
          className="max-h-32 flex-1 resize-none rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 dark:border-slate-700 dark:bg-surface-dark-subtle"
        />
        <Button type="submit" disabled={!draft.trim()} isLoading={isSending} aria-label="Send message">
          <SendIcon width={18} height={18} />
        </Button>
      </form>
    </div>
  );
}
