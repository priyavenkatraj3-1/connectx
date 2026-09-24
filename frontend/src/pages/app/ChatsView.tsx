import { ChatListPanel } from "../../components/chat/ChatListPanel";
import { ConversationArea } from "../../components/chat/ConversationArea";

export function ChatsView() {
  return (
    <div className="flex flex-1 overflow-hidden">
      <ChatListPanel />
      <ConversationArea />
    </div>
  );
}
