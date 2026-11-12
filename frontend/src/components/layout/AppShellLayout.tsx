import { Outlet } from "react-router-dom";
import { AIProvider } from "../../context/AIContext";
import { CallProvider } from "../../context/CallContext";
import { ConversationsProvider } from "../../context/ConversationsContext";
import { OfflineProvider, useOptionalOffline } from "../../context/OfflineContext";
import { WorkspaceProvider } from "../../context/WorkspaceContext";
import { CallOverlay } from "../calls/CallOverlay";
import { WifiOffIcon } from "../ui/icons";
import { useOwnProfileSync } from "../../hooks/useOwnProfileSync";
import { Sidebar } from "./Sidebar";

function OfflineBanner() {
  const offline = useOptionalOffline();
  if (!offline || offline.isOnline) return null;
  const waiting = offline.outbox.filter((item) => item.state !== "failed").length;
  return (
    <div role="status" className="flex items-center justify-center gap-2 bg-amber-100 px-4 py-1.5 text-xs font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-200">
      <WifiOffIcon width={14} height={14} aria-hidden="true" />
      You’re offline. {waiting > 0 ? `${waiting} message${waiting === 1 ? "" : "s"} will be sent when you reconnect.` : "Messages you send will be queued."}
    </div>
  );
}

export function AppShellLayout() {
  useOwnProfileSync();
  return (
    <OfflineProvider>
      <ConversationsProvider>
        <WorkspaceProvider>
          <CallProvider>
            <AIProvider>
              <div className="flex h-screen w-screen flex-col overflow-hidden bg-surface-subtle dark:bg-surface-dark">
                <OfflineBanner />
                <div className="flex flex-1 overflow-hidden">
                  <Sidebar />
                  <Outlet />
                </div>
              </div>
            </AIProvider>
            <CallOverlay />
          </CallProvider>
        </WorkspaceProvider>
      </ConversationsProvider>
    </OfflineProvider>
  );
}
