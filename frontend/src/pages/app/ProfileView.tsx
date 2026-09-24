import { useAuth } from "../../context/AuthContext";
import { Avatar } from "../../components/ui/Avatar";
import { Button } from "../../components/ui/Button";

export function ProfileView() {
  const { user } = useAuth();

  return (
    <div className="flex flex-1 flex-col overflow-y-auto p-8">
      <div className="mx-auto w-full max-w-xl">
        <h1 className="mb-6 text-xl font-semibold text-slate-900 dark:text-slate-100">Your Profile</h1>

        <div className="flex items-center gap-5 rounded-xl2 border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-surface-dark-subtle">
          <Avatar name={user?.displayName ?? "?"} size="lg" />
          <div className="flex-1">
            <p className="text-lg font-medium text-slate-900 dark:text-slate-100">{user?.displayName}</p>
            <p className="text-sm text-slate-500 dark:text-slate-400">{user?.email}</p>
          </div>
          <Button variant="secondary" disabled title="Coming soon">
            Edit profile
          </Button>
        </div>

        <div className="mt-6 rounded-xl2 border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-surface-dark-subtle">
          <h2 className="mb-2 text-sm font-semibold text-slate-900 dark:text-slate-100">About</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            A status message and profile photo will appear here once profile editing is available in a
            later phase.
          </p>
        </div>
      </div>
    </div>
  );
}
