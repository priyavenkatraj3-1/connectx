import { EmptyState } from "../common/EmptyState";
import { ChatIcon } from "../ui/icons";

export function ConversationArea() {
  return (
    <div className="hidden flex-1 flex-col md:flex">
      <EmptyState
        icon={<ChatIcon width={28} height={28} />}
        title="Select a conversation"
        message="Choose a chat from the list, or start a new one to begin messaging."
      />
    </div>
  );
}
