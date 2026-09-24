import { NavLink } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { Avatar } from "../ui/Avatar";
import { ChatIcon, LogoutIcon, SettingsIcon, StatusIcon } from "../ui/icons";

const navLinkClasses = ({ isActive }: { isActive: boolean }) =>
  `flex h-11 w-11 items-center justify-center rounded-xl transition-colors ${
    isActive
      ? "bg-brand-600 text-white"
      : "text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
  }`;

export function Sidebar() {
  const { user, logout } = useAuth();

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
        <NavLink to="/app" end className={navLinkClasses} aria-label="Chats">
          <ChatIcon />
        </NavLink>
        <NavLink to="/app/status" className={navLinkClasses} aria-label="Status">
          <StatusIcon />
        </NavLink>
        <NavLink to="/app/settings" className={navLinkClasses} aria-label="Settings">
          <SettingsIcon />
        </NavLink>
      </div>

      <div className="flex flex-col items-center gap-3">
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
