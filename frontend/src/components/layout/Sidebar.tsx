import { useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { useConversations } from "../../context/ConversationsContext";
import { useOptionalWorkspace } from "../../context/WorkspaceContext";
import { NotificationCenter } from "../productivity/NotificationCenter";
import { Avatar } from "../ui/Avatar";
import { BellIcon, ChatIcon, ChecklistIcon, LogoutIcon, SettingsIcon, SparkleIcon, StatusIcon } from "../ui/icons";

function navLinkClasses(isActive: boolean): string {
  return `relative flex h-11 w-11 items-center justify-center rounded-xl transition-colors ${
    isActive ? "bg-brand-600 text-white" : "text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
  }`;
}

function Badge({ count, tone = "accent" }: { count: number; tone?: "accent" | "red" }) {
  if (count <= 0) return null;
  return (
    <span
      className={`absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold text-white ${
        tone === "red" ? "bg-red-500" : "bg-accent-500"
      }`}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

export function Sidebar() {
  const { user, logout } = useAuth();
  const { totalUnreadCount } = useConversations();
  const workspace = useOptionalWorkspace();
  const location = useLocation();
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const isChatsActive = location.pathname === "/app" || location.pathname.startsWith("/app/chat");

  return (
    <nav
      className="flex h-full w-[72px] shrink-0 flex-col items-center justify-between border-r border-slate-200 bg-white py-4 dark:border-slate-800 dark:bg-surface-dark"
      aria-label="Primary"
    >
      <div className="flex flex-col items-center gap-4">
        <div
          className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500 to-accent-500 text-sm font-bold text-white"
          aria-hidden="true"
        >
          CX
        </div>
        <Link to="/app" className={navLinkClasses(isChatsActive)} aria-label="Chats">
          <ChatIcon />
          <Badge count={totalUnreadCount} />
        </Link>
        <NavLink to="/app/status" className={({ isActive }) => navLinkClasses(isActive)} aria-label="Status">
          <StatusIcon />
        </NavLink>
        {workspace && (
          <NavLink to="/app/work" className={({ isActive }) => navLinkClasses(isActive)} aria-label="Work">
            <ChecklistIcon />
          </NavLink>
        )}
        <NavLink to="/app/ai" className={({ isActive }) => navLinkClasses(isActive)} aria-label="Ask Your Chats">
          <SparkleIcon />
        </NavLink>
        <NavLink to="/app/settings" className={({ isActive }) => navLinkClasses(isActive)} aria-label="Settings">
          <SettingsIcon />
        </NavLink>
      </div>

      <div className="flex flex-col items-center gap-3">
        {workspace && (
          <div className="relative">
            <button
              type="button"
              onClick={() => setNotificationsOpen((open) => !open)}
              className={navLinkClasses(notificationsOpen)}
              aria-label={`Notifications${workspace.unreadNotifications > 0 ? ` (${workspace.unreadNotifications} unread)` : ""}`}
              aria-expanded={notificationsOpen}
            >
              <BellIcon />
              <Badge count={workspace.unreadNotifications} tone="red" />
            </button>
            {notificationsOpen && <NotificationCenter onClose={() => setNotificationsOpen(false)} />}
          </div>
        )}
        <button
          type="button"
          onClick={() => void logout()}
          className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-500 transition-colors hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
          aria-label="Log out"
        >
          <LogoutIcon />
        </button>
        <NavLink to="/app/profile" aria-label="Your profile">
          <Avatar name={user?.displayName ?? "?"} size="sm" />
        </NavLink>
      </div>
    </nav>
  );
}
