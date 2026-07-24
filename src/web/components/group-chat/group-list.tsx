import { useState, useEffect, useCallback } from "react";
import { Plus, Users, Loader2, Trash2 } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useProjectStore } from "@/stores/project-store";
import { usePanelStore } from "@/stores/panel-store";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/adaptive-context-menu";
import { listGroups, deleteGroup } from "@/lib/api-group-chat";
import { GroupCreateDialog } from "./group-create-dialog";
import type { Group } from "../../../types/group-chat";

/** Sidebar "Teams" panel: lists project groups, opens a group tab on click. */
export function GroupList() {
  const { activeProject } = useProjectStore(useShallow((s) => ({ activeProject: s.activeProject })));
  const openTab = usePanelStore((s) => s.openTab);
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const projectPath = activeProject?.path ?? null;
  const projectName = activeProject?.name ?? "";

  const refresh = useCallback(() => {
    if (!projectPath) { setGroups([]); return; }
    setLoading(true);
    listGroups(projectPath)
      .then(setGroups)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load groups"))
      .finally(() => setLoading(false));
  }, [projectPath]);

  useEffect(() => { refresh(); }, [refresh]);

  const openGroup = useCallback((group: Group) => {
    openTab({
      type: "group",
      title: group.name,
      projectId: projectName,
      closable: true,
      metadata: { groupId: group.id, projectName },
    });
  }, [openTab, projectName]);

  const handleDelete = useCallback(async (group: Group) => {
    try {
      await deleteGroup(group.id);
      setGroups((prev) => prev.filter((g) => g.id !== group.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete group");
    }
  }, []);

  if (!activeProject) {
    return (
      <div className="flex items-center justify-center h-24 p-4">
        <p className="text-xs text-text-subtle text-center">Select a project to view groups</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border px-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Teams</span>
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="flex size-11 items-center justify-center rounded-md text-text-subtle hover:bg-surface-elevated hover:text-foreground md:size-7"
          aria-label="New group"
        >
          <Plus className="size-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {loading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="size-4 animate-spin text-primary" />
          </div>
        ) : error ? (
          <p className="px-2 py-3 text-xs text-destructive">{error}</p>
        ) : groups.length === 0 ? (
          <p className="px-2 py-3 text-xs text-text-subtle">No groups yet. Create one to start.</p>
        ) : (
          groups.map((g) => (
            <ContextMenu key={g.id}>
              <ContextMenuTrigger asChild>
                <button
                  type="button"
                  onClick={() => openGroup(g)}
                  className="flex w-full min-h-[40px] items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-text-secondary hover:bg-surface-elevated hover:text-foreground"
                >
                  <Users className="size-4 shrink-0 text-text-subtle" />
                  <span className="truncate">{g.name}</span>
                </button>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem variant="destructive" onClick={() => handleDelete(g)}>
                  <Trash2 className="size-4" /> Delete group
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          ))
        )}
      </div>

      <GroupCreateDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        projectName={projectName}
        projectPath={projectPath ?? ""}
        onCreated={(g) => { setGroups((prev) => [g, ...prev]); openGroup(g); }}
      />
    </div>
  );
}
