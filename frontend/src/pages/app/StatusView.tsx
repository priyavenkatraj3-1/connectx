import { EmptyState } from "../../components/common/EmptyState";
import { StatusIcon } from "../../components/ui/icons";

export function StatusView() {
  return (
    <div className="flex flex-1 flex-col">
      <div className="px-6 py-4">
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Status</h1>
      </div>
      <EmptyState
        icon={<StatusIcon width={28} height={28} />}
        title="Status is coming soon"
        message="Share photos, text, and videos that disappear after 24 hours. This feature is planned for a later phase."
      />
    </div>
  );
}
