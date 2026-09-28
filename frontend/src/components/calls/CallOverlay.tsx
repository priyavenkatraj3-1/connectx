import { useAuth } from "../../context/AuthContext";
import { useCalls } from "../../context/CallContext";
import { useConversations } from "../../context/ConversationsContext";
import type { CallDTO } from "../../types/call";
import { Button } from "../ui/Button";
import { CallScreen } from "./CallScreen";
import { IncomingCallDialog } from "./IncomingCallDialog";

/** Renders whichever call UI is needed — incoming ring, call screen, or a start error — above the whole app. */
export function CallOverlay() {
  const calls = useCalls();
  const { user } = useAuth();
  const { getConversation } = useConversations();

  function groupName(call: CallDTO): string | undefined {
    return call.scope === "group" ? (getConversation(call.conversationId)?.group?.name ?? "Group") : undefined;
  }

  function callTitle(call: CallDTO): string {
    if (call.scope === "group") return groupName(call)!;
    return call.participants.find((p) => p.userId !== user?.id)?.displayName ?? "Call";
  }

  const { call, phase, incomingCall } = calls;

  return (
    <>
      {call && phase !== "idle" && (
        <CallScreen
          call={call}
          phase={phase}
          title={callTitle(call)}
          myUserId={user?.id}
          localStream={calls.localStream}
          remoteStreams={calls.remoteStreams}
          peerStates={calls.peerStates}
          micEnabled={calls.micEnabled}
          cameraEnabled={calls.cameraEnabled}
          remoteRinging={calls.remoteRinging}
          notice={calls.notice}
          endSummary={calls.endSummary}
          onHangUp={calls.hangUp}
          onToggleMic={calls.toggleMic}
          onToggleCamera={calls.toggleCamera}
          onRetry={calls.retry}
          onDismiss={calls.dismiss}
        />
      )}

      {incomingCall && (phase === "idle" || phase === "ended") && (
        <IncomingCallDialog
          call={incomingCall}
          callerName={incomingCall.participants.find((p) => p.userId === incomingCall.initiatorId)?.displayName ?? "Someone"}
          groupName={groupName(incomingCall)}
          onAccept={() => void calls.acceptIncoming()}
          onDecline={calls.declineIncoming}
        />
      )}

      {calls.error && phase === "idle" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={calls.dismiss}>
          <div
            role="alertdialog"
            aria-labelledby="call-error-title"
            className="w-full max-w-sm rounded-xl2 bg-white p-5 shadow-xl dark:bg-surface-dark-subtle"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="call-error-title" className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Can't make this call
            </h2>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">{calls.error}</p>
            <div className="mt-4 flex justify-end">
              <Button type="button" onClick={calls.dismiss}>
                OK
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
