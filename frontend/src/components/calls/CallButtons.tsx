import { useCalls } from "../../context/CallContext";
import { PhoneIcon, VideoIcon } from "../ui/icons";

const buttonClasses =
  "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40 dark:text-slate-400 dark:hover:bg-slate-800";

/** Voice + video call buttons for a conversation header. */
export function CallButtons({ conversationId, disabled = false }: { conversationId: string; disabled?: boolean }) {
  const { startCall, isBusy } = useCalls();
  const isDisabled = disabled || isBusy;

  return (
    <>
      <button
        type="button"
        onClick={() => void startCall(conversationId, "voice")}
        disabled={isDisabled}
        className={buttonClasses}
        aria-label="Start voice call"
        title="Voice call"
      >
        <PhoneIcon />
      </button>
      <button
        type="button"
        onClick={() => void startCall(conversationId, "video")}
        disabled={isDisabled}
        className={buttonClasses}
        aria-label="Start video call"
        title="Video call"
      >
        <VideoIcon />
      </button>
    </>
  );
}
