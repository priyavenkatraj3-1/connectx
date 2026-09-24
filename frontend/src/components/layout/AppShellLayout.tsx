import { Outlet } from "react-router-dom";
import { ConversationsProvider } from "../../context/ConversationsContext";
import { Sidebar } from "./Sidebar";

export function AppShellLayout() {
  return (
    <ConversationsProvider>
      <div className="flex h-screen w-screen overflow-hidden bg-surface-subtle dark:bg-surface-dark">
        <Sidebar />
        <Outlet />
      </div>
    </ConversationsProvider>
  );
}
