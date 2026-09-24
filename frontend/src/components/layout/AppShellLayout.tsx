import { Outlet } from "react-router-dom";
import { Sidebar } from "./Sidebar";

export function AppShellLayout() {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-surface-subtle dark:bg-surface-dark">
      <Sidebar />
      <Outlet />
    </div>
  );
}
