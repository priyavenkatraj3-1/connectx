import { type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { AISettingsPanel } from "../../components/ai/AISettingsPanel";
import { BusinessSettings } from "../../components/settings/BusinessSettings";
import { DevicesSettings, NotificationSettings, ProductivitySettings } from "../../components/settings/WorkspaceSettings";
import { Avatar } from "../../components/ui/Avatar";
import { BackIcon } from "../../components/ui/icons";
import { useOptionalAI } from "../../context/AIContext";
import { useOptionalWorkspace } from "../../context/WorkspaceContext";

type SettingsSection = "account" | "privacy" | "productivity" | "notifications" | "devices" | "business" | "ai";

const SECTIONS: Array<{ id: SettingsSection; label: string; description: string }> = [
  { id: "account", label: "Account", description: "Profile, email, and password" },
  { id: "privacy", label: "Privacy & Security", description: "Last seen and read receipts" },
  { id: "productivity", label: "Productivity", description: "Productivity Mode and timezone" },
  { id: "notifications", label: "Notifications", description: "Mentions, reminders, tasks" },
  { id: "devices", label: "Devices", description: "Signed-in devices and sessions" },
  { id: "business", label: "Business", description: "Business profile and quick replies" },
  { id: "ai", label: "AI Features", description: "Assistant, memory, and consent" },
];

function isSection(value: string | null): value is SettingsSection {
  return SECTIONS.some((section) => section.id === value);
}

export function SettingsView() {
  const [params, setParams] = useSearchParams();
  const requested = params.get("section");
  // Below md only one pane shows: the section list until a section is chosen, then that section.
  // Desktop shows both panes and falls back to Account.
  const hasSelection = isSection(requested);
  const active: SettingsSection = isSection(requested) ? requested : "account";
  const setActive = (section: SettingsSection) => setParams({ section });
  const backToOverview = () => setParams({});
  const { user } = useAuth();
  const ai = useOptionalAI();
  // Phase 6 sections need the app shell's workspace (preferences, realtime sync).
  const workspace = useOptionalWorkspace();
  const insideAppOnly = <p className="text-sm text-slate-500 dark:text-slate-400">These settings are available inside the app.</p>;

  return (
    <div className="flex flex-1 overflow-hidden">
      <div
        className={`${hasSelection ? "hidden md:flex" : "flex"} w-full flex-col border-r border-slate-200 dark:border-slate-800 md:w-96`}
        data-testid="settings-nav-pane"
      >
        <div className="px-6 py-4">
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Settings</h1>
        </div>
        <nav className="flex flex-col gap-1 overflow-y-auto px-2">
          {SECTIONS.map((section) => (
            <button
              key={section.id}
              type="button"
              onClick={() => setActive(section.id)}
              aria-current={hasSelection && active === section.id ? "page" : undefined}
              className={`rounded-lg px-4 py-3 text-left transition-colors ${
                active === section.id
                  ? "bg-brand-50 dark:bg-brand-950"
                  : "hover:bg-slate-100 dark:hover:bg-slate-800"
              }`}
            >
              <p
                className={`text-sm font-medium ${
                  active === section.id ? "text-brand-700 dark:text-brand-300" : "text-slate-900 dark:text-slate-100"
                }`}
              >
                {section.label}
              </p>
              <p className="text-xs text-slate-500 dark:text-slate-400">{section.description}</p>
            </button>
          ))}
        </nav>
      </div>

      <div
        className={`${hasSelection ? "flex" : "hidden md:flex"} flex-1 flex-col overflow-y-auto p-4 md:p-8`}
        data-testid="settings-content-pane"
      >
        <button
          type="button"
          onClick={backToOverview}
          className="mb-4 flex items-center gap-1 self-start rounded-lg px-2 py-1 text-sm font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800 md:hidden"
          aria-label="Back to Settings"
        >
          <BackIcon />
          Settings
        </button>
        {active === "account" && (
          <SettingsCard title="Account">
            <div className="flex items-center gap-4">
              <Avatar name={user?.displayName ?? "?"} imageUrl={user?.avatarUrl ?? undefined} size="lg" />
              <div>
                <p className="font-medium text-slate-900 dark:text-slate-100">{user?.displayName}</p>
                <p className="text-sm text-slate-500 dark:text-slate-400">{user?.email}</p>
              </div>
            </div>
          </SettingsCard>
        )}

        {active === "privacy" && (
          <SettingsCard title="Privacy & Security">
            <SettingRow label="Last seen" description="Who can see when you were last online" comingSoon />
            <SettingRow label="Read receipts" description="Let others know when you've read their messages" comingSoon />
            <SettingRow label="Active sessions" description="Review and sign out other devices — see Devices" />
          </SettingsCard>
        )}

        {active === "productivity" && <SettingsCard title="Productivity">{workspace ? <ProductivitySettings /> : insideAppOnly}</SettingsCard>}
        {active === "notifications" && <SettingsCard title="Notifications">{workspace ? <NotificationSettings /> : insideAppOnly}</SettingsCard>}
        {active === "devices" && <SettingsCard title="Devices">{workspace ? <DevicesSettings /> : insideAppOnly}</SettingsCard>}
        {active === "business" && <SettingsCard title="Business">{workspace ? <BusinessSettings /> : insideAppOnly}</SettingsCard>}

        {active === "ai" && (
          <SettingsCard title="AI Features">
            <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">
              ConnectX's AI features are off by default and only ever act on conversations you're a
              part of. Each feature below requires your explicit consent before it activates.
            </p>
            {ai ? (
              <AISettingsPanel />
            ) : (
              <p className="text-sm text-slate-500 dark:text-slate-400">AI settings are available inside the app.</p>
            )}
          </SettingsCard>
        )}
      </div>
    </div>
  );
}

function SettingsCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-xl">
      <h2 className="mb-6 text-lg font-semibold text-slate-900 dark:text-slate-100">{title}</h2>
      {children}
    </div>
  );
}

function SettingRow({
  label,
  description,
  comingSoon,
}: {
  label: string;
  description: string;
  comingSoon?: boolean;
}) {
  return (
    <div className="flex items-center justify-between border-b border-slate-100 py-4 last:border-0 dark:border-slate-800">
      <div>
        <p className="text-sm font-medium text-slate-900 dark:text-slate-100">{label}</p>
        <p className="text-sm text-slate-500 dark:text-slate-400">{description}</p>
      </div>
      {comingSoon && (
        <span className="whitespace-nowrap rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
          Coming soon
        </span>
      )}
    </div>
  );
}
