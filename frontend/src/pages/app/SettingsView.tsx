import { useState, type ReactNode } from "react";
import { useAuth } from "../../context/AuthContext";
import { AISettingsPanel } from "../../components/ai/AISettingsPanel";
import { Avatar } from "../../components/ui/Avatar";
import { useOptionalAI } from "../../context/AIContext";

type SettingsSection = "account" | "privacy" | "ai" | "notifications";

const SECTIONS: Array<{ id: SettingsSection; label: string; description: string }> = [
  { id: "account", label: "Account", description: "Profile, email, and password" },
  { id: "privacy", label: "Privacy & Security", description: "Visibility, sessions, devices" },
  { id: "ai", label: "AI Features", description: "Assistant, memory, and consent" },
  { id: "notifications", label: "Notifications", description: "Message and mention alerts" },
];

export function SettingsView() {
  const [active, setActive] = useState<SettingsSection>("account");
  const { user } = useAuth();
  const ai = useOptionalAI();

  return (
    <div className="flex flex-1 overflow-hidden">
      <div className="flex w-full flex-col border-r border-slate-200 dark:border-slate-800 md:w-96">
        <div className="px-6 py-4">
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Settings</h1>
        </div>
        <nav className="flex flex-col gap-1 px-2">
          {SECTIONS.map((section) => (
            <button
              key={section.id}
              type="button"
              onClick={() => setActive(section.id)}
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

      <div className="hidden flex-1 flex-col overflow-y-auto p-8 md:flex">
        {active === "account" && (
          <SettingsCard title="Account">
            <div className="flex items-center gap-4">
              <Avatar name={user?.displayName ?? "?"} size="lg" />
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
            <SettingRow label="Active sessions" description="Review and sign out other devices" comingSoon />
          </SettingsCard>
        )}

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

        {active === "notifications" && (
          <SettingsCard title="Notifications">
            <SettingRow label="Messages" description="Get notified about new messages" comingSoon />
            <SettingRow label="Mentions" description="Get notified when someone mentions you in a group" comingSoon />
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
