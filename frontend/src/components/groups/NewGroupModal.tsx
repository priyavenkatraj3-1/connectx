import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { useConversations } from "../../context/ConversationsContext";
import { groupService } from "../../services/groupService";
import type { PublicProfile } from "../../types/user";
import { Button } from "../ui/Button";
import { MemberPicker } from "./MemberPicker";

const NAME_MAX = 120;
const DESCRIPTION_MAX = 500;

export function NewGroupModal({ onClose }: { onClose: () => void }) {
  const { accessToken } = useAuth();
  const { refresh } = useConversations();
  const navigate = useNavigate();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [members, setMembers] = useState<PublicProfile[]>([]);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = name.trim().length > 0 && members.length > 0 && !isCreating;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!accessToken || !canSubmit) return;
    setIsCreating(true);
    setError(null);
    try {
      const { group } = await groupService.create(accessToken, {
        name: name.trim(),
        description: description.trim() || undefined,
        memberIds: members.map((m) => m.id),
      });
      await refresh();
      onClose();
      navigate(`/app/chat/${group.conversationId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the group");
      setIsCreating(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-16" onClick={onClose}>
      <form
        onSubmit={handleSubmit}
        className="flex max-h-[85vh] w-full max-w-md flex-col rounded-xl2 bg-white shadow-xl dark:bg-surface-dark-subtle"
        onClick={(e) => e.stopPropagation()}
        aria-labelledby="new-group-title"
      >
        <div className="border-b border-slate-100 p-4 dark:border-slate-800">
          <h2 id="new-group-title" className="text-base font-semibold text-slate-900 dark:text-slate-100">
            New group
          </h2>
        </div>

        <div className="flex flex-col gap-4 overflow-y-auto p-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-slate-700 dark:text-slate-200">Group name</span>
            <input
              autoFocus
              value={name}
              maxLength={NAME_MAX}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Weekend trip"
              className="rounded-lg border border-slate-200 px-3.5 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 dark:border-slate-700 dark:bg-surface-dark dark:text-slate-100"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-slate-700 dark:text-slate-200">
              Description <span className="font-normal text-slate-400">(optional)</span>
            </span>
            <textarea
              value={description}
              maxLength={DESCRIPTION_MAX}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="resize-none rounded-lg border border-slate-200 px-3.5 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 dark:border-slate-700 dark:bg-surface-dark dark:text-slate-100"
            />
          </label>

          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-slate-700 dark:text-slate-200">
              Members <span className="font-normal text-slate-400">({members.length} selected)</span>
            </span>
            <MemberPicker selected={members} onChange={setMembers} />
          </div>

          {error && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {error}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-100 p-4 dark:border-slate-800">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!canSubmit} isLoading={isCreating}>
            Create group
          </Button>
        </div>
      </form>
    </div>
  );
}
