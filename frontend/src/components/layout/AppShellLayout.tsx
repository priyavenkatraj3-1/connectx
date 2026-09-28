import { Outlet } from "react-router-dom";
import { CallProvider } from "../../context/CallContext";
import { ConversationsProvider } from "../../context/ConversationsContext";
import { CallOverlay } from "../calls/CallOverlay";
import { Sidebar } from "./Sidebar";

export function AppShellLayout() {
  return (
    <ConversationsProvider>
      <CallProvider>
        <div className="flex h-screen w-screen overflow-hidden bg-surface-subtle dark:bg-surface-dark">
          <Sidebar />
          <Outlet />
        </div>
        <CallOverlay />
      </CallProvider>
    </ConversationsProvider>
  );
}
