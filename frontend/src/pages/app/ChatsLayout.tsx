import { Outlet } from "react-router-dom";
import { ChatListPanel } from "../../components/chat/ChatListPanel";

/** Shared two-pane layout for /app (chat list + whatever conversation view is active) — see ChatConversationPage and ChatsView. */
export function ChatsLayout() {
  return (
    <div className="flex flex-1 overflow-hidden">
      <ChatListPanel />
      <Outlet />
    </div>
  );
}
