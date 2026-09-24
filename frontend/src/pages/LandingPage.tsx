import { Link } from "react-router-dom";
import { Button } from "../components/ui/Button";
import { ShieldIcon, SparkleIcon, ChatIcon } from "../components/ui/icons";

const FEATURES = [
  {
    icon: <ChatIcon width={22} height={22} />,
    title: "Real-time messaging",
    description: "Fast, reliable conversations that sync across every device you use.",
  },
  {
    icon: <ShieldIcon width={22} height={22} />,
    title: "Built on privacy",
    description: "Clear, user-controlled privacy settings — your data stays yours.",
  },
  {
    icon: <SparkleIcon width={22} height={22} />,
    title: "AI that asks first",
    description: "Optional AI features like chat search and memory, always opt-in and explainable.",
  },
];

export function LandingPage() {
  return (
    <div className="flex min-h-screen flex-col bg-surface-subtle dark:bg-surface-dark">
      <header className="flex items-center justify-between px-6 py-5 md:px-12">
        <div className="flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500 to-accent-500 text-sm font-bold text-white">
            CX
          </div>
          <span className="text-lg font-semibold text-slate-900 dark:text-slate-100">ConnectX</span>
        </div>
        <div className="flex items-center gap-3">
          <Link to="/login" className="text-sm font-medium text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white">
            Log in
          </Link>
          <Link to="/signup">
            <Button>Sign up free</Button>
          </Link>
        </div>
      </header>

      <main className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center md:px-12">
        <span className="mb-4 rounded-full bg-brand-50 px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-brand-700 dark:bg-brand-950 dark:text-brand-300">
          Phase 1 &middot; Foundation
        </span>
        <h1 className="max-w-2xl text-4xl font-bold tracking-tight text-slate-900 dark:text-slate-100 md:text-5xl">
          Communication, built around you.
        </h1>
        <p className="mt-5 max-w-xl text-lg text-slate-600 dark:text-slate-400">
          ConnectX brings messaging, calls, groups, and thoughtful AI assistance together —
          with privacy and control at the center of every design decision.
        </p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <Link to="/signup">
            <Button className="px-6 py-3 text-base">Create your account</Button>
          </Link>
          <Link to="/login">
            <Button variant="secondary" className="px-6 py-3 text-base">
              I already have an account
            </Button>
          </Link>
        </div>

        <div className="mt-20 grid w-full max-w-4xl gap-6 sm:grid-cols-3">
          {FEATURES.map((feature) => (
            <div
              key={feature.title}
              className="rounded-xl2 border border-slate-200 bg-white p-6 text-left dark:border-slate-800 dark:bg-surface-dark-subtle"
            >
              <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-950 dark:text-brand-300">
                {feature.icon}
              </div>
              <h3 className="mb-1 text-sm font-semibold text-slate-900 dark:text-slate-100">{feature.title}</h3>
              <p className="text-sm text-slate-500 dark:text-slate-400">{feature.description}</p>
            </div>
          ))}
        </div>
      </main>

      <footer className="px-6 py-6 text-center text-xs text-slate-400 md:px-12">
        &copy; {new Date().getFullYear()} ConnectX. This is an in-development project (Phase 1).
      </footer>
    </div>
  );
}
