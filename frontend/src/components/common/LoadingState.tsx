export function LoadingState({ label = "Loading..." }: { label?: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-slate-500 dark:text-slate-400">
      <span
        className="h-8 w-8 animate-spin rounded-full border-2 border-brand-500 border-t-transparent"
        role="status"
        aria-label={label}
      />
      <p className="text-sm">{label}</p>
    </div>
  );
}
