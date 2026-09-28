import type { StatusBackgroundColor } from "../../types/status";

/** Tailwind classes for text-status backgrounds (full class names, so Tailwind's scanner keeps them). */
export const STATUS_BACKGROUND_CLASSES: Record<StatusBackgroundColor, string> = {
  indigo: "bg-gradient-to-br from-brand-600 to-brand-900",
  rose: "bg-gradient-to-br from-rose-500 to-rose-800",
  emerald: "bg-gradient-to-br from-emerald-500 to-emerald-800",
  amber: "bg-gradient-to-br from-amber-500 to-orange-700",
  slate: "bg-gradient-to-br from-slate-600 to-slate-900",
  violet: "bg-gradient-to-br from-violet-500 to-fuchsia-800",
};

/** "5m ago", "3h ago" — statuses never live longer than a day. */
export function formatStatusAge(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

export function isExpired(expiresAt: string, now = Date.now()): boolean {
  return new Date(expiresAt).getTime() <= now;
}
