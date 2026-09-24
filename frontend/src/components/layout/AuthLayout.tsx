import type { ReactNode } from "react";
import { Link } from "react-router-dom";

export function AuthLayout({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="flex min-h-screen bg-surface-subtle dark:bg-surface-dark">
      <div className="hidden flex-1 flex-col justify-between bg-gradient-to-br from-brand-600 to-accent-600 p-12 text-white lg:flex">
        <Link to="/" className="flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/15 text-sm font-bold">CX</div>
          <span className="text-lg font-semibold">ConnectX</span>
        </Link>
        <div>
          <h2 className="mb-3 text-3xl font-semibold">Stay connected, on your terms.</h2>
          <p className="max-w-sm text-white/80">
            Messaging, groups, and AI features designed with privacy and consent built in from
            day one.
          </p>
        </div>
        <p className="text-sm text-white/60">&copy; {new Date().getFullYear()} ConnectX</p>
      </div>

      <div className="flex flex-1 flex-col items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <Link to="/" className="mb-8 flex items-center gap-2 lg:hidden">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500 to-accent-500 text-sm font-bold text-white">
              CX
            </div>
            <span className="text-lg font-semibold text-slate-900 dark:text-slate-100">ConnectX</span>
          </Link>
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">{title}</h1>
          <p className="mt-1 mb-8 text-sm text-slate-500 dark:text-slate-400">{subtitle}</p>
          {children}
        </div>
      </div>
    </div>
  );
}
