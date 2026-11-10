/**
 * "Assign / create" (and "Replace…") for one project: pick one of the project's Claude chats, or
 * create a new manager chat. Picking a chat hands over to the same "Set as manager chat" dialog
 * the session list uses, which states what the role means, the chat's mode and the manager it
 * replaces before anything is assigned. Creating one states the same consequence here first.
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, MessageSquarePlus } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { SetManagerChatDialog } from "@/components/chat/set-manager-chat-dialog";
import { createManagerChat } from "@/lib/assistant-settings-client";
import { managerModeLabel } from "@/lib/assistant-manager-table";
import { projectCacheId } from "@/lib/browser-cache/cache-keys";
import { useSessionListStore, EMPTY_SESSIONS } from "@/stores/session-list-store";
import { useProjectRef } from "@/stores/session-list-sync-triggers";
import { canOfferManagerRole, MANAGER_ASSIGN_CONSEQUENCE, type ManagerChatSummary } from "../../../../shared/assistant-managers";
import type { ManagerMode } from "../../../../shared/assistant-settings";
import { AssistantSettingsDialog, DIALOG_BUTTON, DialogActions } from "./assistant-settings-dialog";

export function AssignManagerDialog({ projectName, current, defaultMode, onClose }: {
  projectName: string;
  /** The project's manager now, when this is a replace. */
  current: ManagerChatSummary | null;
  defaultMode: ManagerMode;
  onClose: () => void;
}) {
  const project = useProjectRef(projectName);
  const id = project ? projectCacheId(project) : null;
  useEffect(() => { if (project) void useSessionListStore.getState().ensure(project); }, [project]);
  const sessions = useSessionListStore((s) => (id ? s.byProject[id]?.sessions : undefined) ?? EMPTY_SESSIONS);
  const synced = useSessionListStore((s) => {
    const entry = id ? s.byProject[id] : undefined;
    return Boolean(entry && (entry.lastSyncedAt !== null || entry.lastSyncError));
  });
  const [picked, setPicked] = useState<{ id: string; title: string } | null>(null);
  const [creating, setCreating] = useState(false);

  const chats = sessions.filter((s) => canOfferManagerRole(s, projectName) && s.id !== current?.sessionId);

  if (picked) {
    return <SetManagerChatDialog projectName={projectName} sessionId={picked.id} sessionTitle={picked.title} onClose={onClose} />;
  }

  const create = async () => {
    setCreating(true);
    try {
      await createManagerChat(projectName);
      toast.success(`Created the ${projectName} manager chat`);
      onClose();
    } catch (e) {
      toast.error("Could not create the manager chat", { description: e instanceof Error ? e.message : String(e) });
      setCreating(false);
    }
  };

  return (
    <AssistantSettingsDialog open title={current ? `Replace the ${projectName} manager` : `Manager chat for ${projectName}`} onClose={onClose}>
      <div className="space-y-3 text-sm">
        <p className="text-text-secondary">{MANAGER_ASSIGN_CONSEQUENCE}</p>
        <div className="space-y-1">
          <p className="text-xs text-text-subtle">Use one of the project's Claude chats</p>
          {!synced && chats.length === 0 && <p className="flex items-center gap-2 text-text-subtle"><Loader2 className="size-3.5 animate-spin" />Loading chats…</p>}
          {synced && chats.length === 0 && <p className="text-text-subtle">No Claude chat in this project can take the role yet.</p>}
          {chats.length > 0 && (
            <ul className="max-h-64 divide-y divide-border-soft overflow-y-auto rounded-md border border-border" aria-label={`${projectName} chats`}>
              {chats.map((s) => (
                <li key={s.id}>
                  <button type="button" onClick={() => setPicked({ id: s.id, title: s.title ?? "" })}
                    className="flex min-h-11 w-full items-center px-3 text-left hover:bg-surface-elevated active:bg-surface-elevated md:min-h-9">
                    <span className="min-w-0 flex-1 truncate">{s.title || "Untitled chat"}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="space-y-1 rounded-md border border-border p-3">
          <p className="font-medium">Create new manager chat</p>
          <p className="text-xs text-text-subtle">
            A new Claude chat titled “Manager”, in {managerModeLabel(defaultMode)} mode
            {defaultMode === "bypassPermissions" ? ", which runs without approval prompts" : ""}.
            Its rules start from your template.
          </p>
        </div>
        <DialogActions>
          <Button type="button" variant="outline" onClick={onClose} className={DIALOG_BUTTON}>Cancel</Button>
          <Button type="button" onClick={() => void create()} disabled={creating} className={`${DIALOG_BUTTON} gap-1.5`}>
            {creating ? <Loader2 className="size-3.5 animate-spin" /> : <MessageSquarePlus className="size-4" />}
            Create new manager chat
          </Button>
        </DialogActions>
      </div>
    </AssistantSettingsDialog>
  );
}
