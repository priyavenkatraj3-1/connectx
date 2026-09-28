import { useState, type FormEvent } from "react";
import { useAuth } from "../../context/AuthContext";
import { groupService } from "../../services/groupService";
import type { GroupDetails, GroupMemberDTO } from "../../types/group";
import type { PublicProfile } from "../../types/user";
import { groupPermissions, ROLE_LABELS } from "../../utils/conversationDisplay";
import { Avatar } from "../ui/Avatar";
import { Button } from "../ui/Button";
import { CloseIcon } from "../ui/icons";
import { MemberPicker } from "./MemberPicker";

interface GroupDetailsPanelProps {
  details: GroupDetails;
  onChange(details: GroupDetails): void;
  onLeft(): void;
  onClose(): void;
}

/**
 * Group info side panel. Which controls appear depends on the viewer's
 * role (see groupPermissions) — purely cosmetic: the server re-checks every
 * action and its error message is shown if it refuses.
 */
export function GroupDetailsPanel({ details, onChange, onLeft, onClose }: GroupDetailsPanelProps) {
  const { accessToken, user } = useAuth();
  const { group, members } = details;
  const myRole = group.myRole;

  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const [isEditing, setIsEditing] = useState(false);
  const [name, setName] = useState(group.name);
  const [description, setDescription] = useState(group.description ?? "");
  const [avatarUrl, setAvatarUrl] = useState(group.avatarUrl ?? "");

  const [isAdding, setIsAdding] = useState(false);
  const [toAdd, setToAdd] = useState<PublicProfile[]>([]);

  const [confirmingLeave, setConfirmingLeave] = useState(false);

  async function run(key: string, action: () => Promise<void>) {
    setBusyKey(key);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusyKey(null);
    }
  }

  function saveDetails(e: FormEvent) {
    e.preventDefault();
    if (!accessToken) return;
    void run("edit", async () => {
      const updated = await groupService.update(accessToken, group.id, {
        name: name.trim(),
        description: description.trim() || null,
        avatarUrl: avatarUrl.trim() || null,
      });
      onChange(updated);
      setIsEditing(false);
    });
  }

  function addSelected() {
    if (!accessToken || toAdd.length === 0) return;
    void run("add", async () => {
      onChange(await groupService.addMembers(accessToken, group.id, toAdd.map((p) => p.id)));
      setToAdd([]);
      setIsAdding(false);
    });
  }

  function removeMember(member: GroupMemberDTO) {
    if (!accessToken) return;
    void run(`remove:${member.userId}`, async () => {
      onChange(await groupService.removeMember(accessToken, group.id, member.userId));
    });
  }

  function setRole(member: GroupMemberDTO, role: "admin" | "member") {
    if (!accessToken) return;
    void run(`role:${member.userId}`, async () => {
      onChange(await groupService.changeRole(accessToken, group.id, member.userId, role));
    });
  }

  function leave() {
    if (!accessToken) return;
    void run("leave", async () => {
      await groupService.leave(accessToken, group.id);
      onLeft();
    });
  }

  const inputClasses =
    "rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 dark:border-slate-700 dark:bg-surface-dark dark:text-slate-100";

  return (
    <aside
      className="flex w-full shrink-0 flex-col border-l border-slate-200 bg-white dark:border-slate-800 dark:bg-surface-dark md:w-80"
      aria-label="Group details"
    >
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Group info</h2>
        <button
          type="button"
          onClick={onClose}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
          aria-label="Close group info"
        >
          <CloseIcon width={18} height={18} />
        </button>
      </div>

      <div className="flex flex-1 flex-col gap-5 overflow-y-auto p-4">
        {error && (
          <p role="alert" className="rounded-lg bg-red-50 p-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
            {error}
          </p>
        )}

        {isEditing ? (
          <form onSubmit={saveDetails} className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-xs font-medium text-slate-600 dark:text-slate-300">
              Name
              <input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} className={inputClasses} />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-slate-600 dark:text-slate-300">
              Description
              <textarea
                value={description}
                maxLength={500}
                rows={3}
                onChange={(e) => setDescription(e.target.value)}
                className={`${inputClasses} resize-none`}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-slate-600 dark:text-slate-300">
              Avatar image URL
              <input
                value={avatarUrl}
                type="url"
                placeholder="https://…"
                onChange={(e) => setAvatarUrl(e.target.value)}
                className={inputClasses}
              />
              <span className="font-normal text-slate-400">Uploading a group photo comes in a later phase.</span>
            </label>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setIsEditing(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!name.trim()} isLoading={busyKey === "edit"}>
                Save
              </Button>
            </div>
          </form>
        ) : (
          <div className="flex flex-col items-center gap-2 text-center">
            <Avatar name={group.name} imageUrl={group.avatarUrl ?? undefined} size="lg" />
            <p className="text-base font-semibold text-slate-900 dark:text-slate-100">{group.name}</p>
            {group.description && <p className="text-sm text-slate-500 dark:text-slate-400">{group.description}</p>}
            <p className="text-xs text-slate-400">
              {members.length} {members.length === 1 ? "member" : "members"} · You are {ROLE_LABELS[myRole].toLowerCase()}
            </p>
            {groupPermissions.canEditDetails(myRole) && (
              <Button
                variant="secondary"
                onClick={() => {
                  // Start from the latest values (they may have changed via realtime updates).
                  setName(group.name);
                  setDescription(group.description ?? "");
                  setAvatarUrl(group.avatarUrl ?? "");
                  setIsEditing(true);
                }}
                className="mt-1 py-1.5 text-xs"
              >
                Edit group
              </Button>
            )}
          </div>
        )}

        <section aria-labelledby="group-members-heading" className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h3 id="group-members-heading" className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              Members
            </h3>
            {groupPermissions.canAddMembers(myRole) && !isAdding && (
              <button
                type="button"
                onClick={() => setIsAdding(true)}
                className="text-xs font-medium text-brand-600 hover:underline dark:text-brand-300"
              >
                Add members
              </button>
            )}
          </div>

          {isAdding && (
            <div className="flex flex-col gap-2 rounded-lg border border-slate-200 p-2 dark:border-slate-700">
              <MemberPicker selected={toAdd} onChange={setToAdd} excludeIds={members.map((m) => m.userId)} autoFocus />
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  className="py-1.5 text-xs"
                  onClick={() => {
                    setIsAdding(false);
                    setToAdd([]);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  className="py-1.5 text-xs"
                  disabled={toAdd.length === 0}
                  isLoading={busyKey === "add"}
                  onClick={addSelected}
                >
                  Add {toAdd.length > 0 ? toAdd.length : ""}
                </Button>
              </div>
            </div>
          )}

          <ul className="flex flex-col">
            {members.map((member) => {
              const isMe = member.userId === user?.id;
              const canRemove = !isMe && groupPermissions.canRemove(myRole, member.role);
              const canChangeRole = !isMe && member.role !== "owner" && groupPermissions.canChangeRoles(myRole);
              return (
                <li key={member.userId} className="flex items-center gap-2.5 py-2" data-testid={`member-${member.userId}`}>
                  <Avatar name={member.displayName} imageUrl={member.avatarUrl ?? undefined} size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                      {member.displayName}
                      {isMe && <span className="font-normal text-slate-400"> (you)</span>}
                    </p>
                    {member.role !== "member" && (
                      <span className="text-[11px] font-semibold uppercase tracking-wide text-brand-600 dark:text-brand-300">
                        {ROLE_LABELS[member.role]}
                      </span>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {canChangeRole && (
                      <button
                        type="button"
                        disabled={busyKey !== null}
                        onClick={() => setRole(member, member.role === "admin" ? "member" : "admin")}
                        className="rounded-md px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 disabled:opacity-50 dark:text-slate-300 dark:hover:bg-slate-800"
                      >
                        {member.role === "admin" ? "Remove admin" : "Make admin"}
                      </button>
                    )}
                    {canRemove && (
                      <button
                        type="button"
                        disabled={busyKey !== null}
                        onClick={() => removeMember(member)}
                        className="rounded-md px-2 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-950"
                        aria-label={`Remove ${member.displayName}`}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>

        <div className="mt-auto border-t border-slate-200 pt-4 dark:border-slate-800">
          {confirmingLeave ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-slate-600 dark:text-slate-300">
                {myRole === "owner" && members.length > 1
                  ? "You're the owner. Ownership will pass to the longest-standing admin (or member). Leave anyway?"
                  : "Leave this group? You'll stop receiving its messages."}
              </p>
              <div className="flex gap-2">
                <Button variant="danger" onClick={leave} isLoading={busyKey === "leave"} className="flex-1">
                  Leave group
                </Button>
                <Button variant="ghost" onClick={() => setConfirmingLeave(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="secondary" onClick={() => setConfirmingLeave(true)} className="w-full text-red-600 dark:text-red-400">
              Leave group
            </Button>
          )}
        </div>
      </div>
    </aside>
  );
}
