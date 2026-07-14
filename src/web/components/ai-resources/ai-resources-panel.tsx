import { useEffect, useMemo, useState } from "react";
import { RefreshCw, Search, Sparkles, FolderOpen } from "lucide-react";
import { SidebarHeader } from "@/components/ui/sidebar-header";
import { useShallow } from "zustand/react/shallow";
import { useProjectStore } from "@/stores/project-store";
import { useTabStore } from "@/stores/tab-store";
import { useAiResourcesStore } from "@/stores/ai-resources-store";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { deleteAiResource, type AiResourceItem, type AiResourceType } from "@/lib/api-ai-resources";
import { importMcpServers, type McpServerEntry } from "@/lib/api-mcp";
import { McpServerDialog } from "@/components/settings/mcp-server-dialog";
import { ResourceRow } from "./resource-row";
import { CreateResourceDialog } from "./create-resource-dialog";
import { DeleteResourceDialog } from "./delete-resource-dialog";
import { TYPE_LABEL } from "./resource-visuals";
import { openResourceTab } from "./open-resource-tab";
import { useMcpServers } from "./use-mcp-servers";
import { McpGroup, serverPreview } from "./mcp-group";
import { NewResourceMenu } from "./new-resource-menu";

type TypeFilter = "all" | AiResourceType | "mcp";
const FILTERS: { id: TypeFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "skill", label: "Skills" },
  { id: "agent", label: "Agents" },
  { id: "command", label: "Commands" },
  { id: "mcp", label: "MCP" },
];

export function AiResourcesPanel() {
  const activeProject = useProjectStore(useShallow((s) => s.activeProject));
  const project = activeProject?.path ?? "";
  const { result, loading, error, load, reload } = useAiResourcesStore(
    useShallow((s) => ({ result: s.result, loading: s.loading, error: s.error, load: s.load, reload: s.reload })),
  );
  const { tabs, activeTabId } = useTabStore(useShallow((s) => ({ tabs: s.tabs, activeTabId: s.activeTabId })));
  const { servers: mcpServers, reload: reloadMcp, remove: removeMcp } = useMcpServers();

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<TypeFilter>("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [createType, setCreateType] = useState<AiResourceType>("skill");
  const [dupSource, setDupSource] = useState<AiResourceItem | null>(null);
  const [delTarget, setDelTarget] = useState<AiResourceItem | null>(null);
  const [mcpDialogOpen, setMcpDialogOpen] = useState(false);
  const [editingMcp, setEditingMcp] = useState<McpServerEntry | null>(null);
  const [delMcp, setDelMcp] = useState<McpServerEntry | null>(null);
  const [importingMcp, setImportingMcp] = useState(false);

  useEffect(() => { load(project); }, [project, load]);

  const activeFilePath = useMemo(() => {
    const t = tabs.find((tab) => tab.id === activeTabId && tab.type === "ai-resource");
    return (t?.metadata?.filePath as string) ?? null;
  }, [tabs, activeTabId]);

  const showFile = filter !== "mcp";
  const showMcp = filter === "all" || filter === "mcp";

  const groups = useMemo(() => {
    if (!result || !showFile) return [];
    const q = search.trim().toLowerCase();
    return result.groups
      .filter((g) => filter === "all" || g.type === filter)
      .map((g) => ({
        ...g,
        items: g.items.filter(
          (i) => !q || i.name.toLowerCase().includes(q) || i.description.toLowerCase().includes(q),
        ),
      }))
      .filter((g) => g.items.length > 0);
  }, [result, filter, search, showFile]);

  const mcpFiltered = useMemo(() => {
    if (!showMcp) return [];
    const q = search.trim().toLowerCase();
    return q
      ? mcpServers.filter((s) => s.name.toLowerCase().includes(q) || serverPreview(s).toLowerCase().includes(q))
      : mcpServers;
  }, [mcpServers, search, showMcp]);

  const handleOpen = (item: AiResourceItem) => openResourceTab(item, project);

  const handleSuccess = async (filePath: string) => {
    await reload();
    const fresh = useAiResourcesStore.getState().result;
    const item = fresh?.groups.flatMap((g) => g.items).find((i) => i.filePath === filePath);
    if (item) openResourceTab(item, project);
  };

  const confirmDelete = async () => {
    if (!delTarget) return;
    try {
      await deleteAiResource(delTarget.filePath, delTarget.type, project);
      toast.success(`Deleted ${delTarget.name}`);
      setDelTarget(null);
      await reload();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const startCreate = (type: AiResourceType) => { setDupSource(null); setCreateType(type); setCreateOpen(true); };
  const openAddMcp = () => { setEditingMcp(null); setMcpDialogOpen(true); };
  const handleMcpDialogClose = (saved?: boolean) => {
    setMcpDialogOpen(false);
    setEditingMcp(null);
    if (saved) void reloadMcp();
  };
  const confirmDeleteMcp = async () => {
    if (!delMcp) return;
    try {
      await removeMcp(delMcp.name);
      toast.success(`Deleted ${delMcp.name}`);
      setDelMcp(null);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const handleImportMcp = async () => {
    setImportingMcp(true);
    try {
      const r = await importMcpServers();
      toast.success(`Imported ${r.imported}, skipped ${r.skipped}`);
      await reloadMcp();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setImportingMcp(false);
    }
  };

  const stats = result?.stats;
  const nothingToShow =
    groups.length === 0 && (!showMcp || mcpFiltered.length === 0) && filter !== "mcp";

  return (
    <div className="flex h-full flex-col">
      <SidebarHeader icon={Sparkles} title="AI Resources">
        <button
          onClick={() => { void reload(); void reloadMcp(); }}
          title="Refresh"
          className="flex size-6 items-center justify-center rounded text-text-subtle hover:bg-surface-elevated hover:text-foreground"
        >
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
        </button>
        <NewResourceMenu onCreate={startCreate} onAddMcp={openAddMcp} onImportMcp={handleImportMcp} />
      </SidebarHeader>

      {/* Search */}
      <div className="px-2 pt-2 shrink-0">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-text-subtle" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter resources…"
            className="w-full rounded-md border border-border bg-surface-elevated py-1.5 pl-7 pr-2 text-xs outline-none focus:border-primary/50"
          />
        </div>
      </div>

      {/* Type filter chips */}
      <div className="flex gap-1 px-2 py-2 shrink-0">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            className={cn(
              "rounded-full border px-2 py-0.5 text-[11px] transition-colors",
              filter === f.id
                ? "border-primary/40 bg-primary/10 text-primary"
                : "border-border text-text-subtle hover:bg-surface-elevated",
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* List */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {error ? (
          <div className="p-4 text-center text-xs text-destructive">{error}</div>
        ) : loading && !result ? (
          <div className="space-y-1 p-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-9 animate-pulse rounded bg-surface-elevated" />
            ))}
          </div>
        ) : nothingToShow ? (
          <EmptyState hasProject={!!activeProject} search={search} />
        ) : (
          <>
            {groups.map((g) => (
              <div key={g.type} className="pb-1">
                <div className="flex items-center gap-1 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-text-subtle">
                  <span>{TYPE_LABEL[g.type]}</span>
                  <span className="text-text-subtle/60">{g.items.length}</span>
                </div>
                {g.items.map((item) => (
                  <ResourceRow
                    key={`${item.source}:${item.filePath}`}
                    item={item}
                    active={activeFilePath === item.filePath}
                    onOpen={handleOpen}
                    onDuplicate={(it) => setDupSource(it)}
                    onDelete={(it) => setDelTarget(it)}
                  />
                ))}
              </div>
            ))}
            {showMcp && (
              <McpGroup
                servers={mcpFiltered}
                showActions={filter === "mcp"}
                importing={importingMcp}
                onAdd={openAddMcp}
                onImport={handleImportMcp}
                onEdit={(s) => { setEditingMcp(s); setMcpDialogOpen(true); }}
                onDelete={(s) => setDelMcp(s)}
              />
            )}
          </>
        )}
      </div>

      {/* Status footer */}
      {stats && (
        <div className="flex items-center gap-2 border-t border-border px-2 py-1 text-[10px] text-text-subtle shrink-0">
          <span>{stats.active} active</span>
          <span>·</span>
          <span>{stats.project} project</span>
          <span>·</span>
          <span>{stats.shadowed} shadowed</span>
        </div>
      )}

      <CreateResourceDialog
        open={createOpen || !!dupSource}
        onOpenChange={(o) => { if (!o) { setCreateOpen(false); setDupSource(null); } }}
        mode={dupSource ? "duplicate" : "create"}
        source={dupSource}
        initialType={createType}
        project={project}
        hasProject={!!activeProject}
        onSuccess={handleSuccess}
      />
      <DeleteResourceDialog
        open={!!delTarget}
        kind={delTarget?.type ?? ""}
        name={delTarget?.name ?? ""}
        folderWarning={delTarget?.type === "skill"}
        onCancel={() => setDelTarget(null)}
        onConfirm={confirmDelete}
      />
      <McpServerDialog open={mcpDialogOpen} onClose={handleMcpDialogClose} editServer={editingMcp} />
      <DeleteResourceDialog
        open={!!delMcp}
        kind="MCP server"
        name={delMcp?.name ?? ""}
        onCancel={() => setDelMcp(null)}
        onConfirm={confirmDeleteMcp}
      />
    </div>
  );
}

function EmptyState({ hasProject, search }: { hasProject: boolean; search: string }) {
  if (search) {
    return <div className="p-6 text-center text-xs text-text-subtle">No resources match “{search}”.</div>;
  }
  return (
    <div className="flex flex-col items-center gap-2 p-6 text-center">
      <FolderOpen className="size-6 text-text-subtle" />
      <p className="text-xs font-medium">{hasProject ? "No resources yet" : "No project selected"}</p>
      <p className="text-[11px] text-text-subtle">
        {hasProject
          ? "Create one with the New button above."
          : "Project resources appear here once a project is open. User & bundled resources are still shown."}
      </p>
    </div>
  );
}
