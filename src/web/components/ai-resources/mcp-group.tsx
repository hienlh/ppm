import { Plug, Plus, Download } from "lucide-react";
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator,
} from "@/components/ui/adaptive-context-menu";
import { cn } from "@/lib/utils";
import type { McpServerEntry } from "@/lib/api-mcp";

interface McpGroupProps {
  /** Already filtered by the panel's search box. */
  servers: McpServerEntry[];
  /** Show the add/import action buttons (only when MCP is the focused filter). */
  showActions: boolean;
  importing: boolean;
  onAdd: () => void;
  onImport: () => void;
  onEdit: (server: McpServerEntry) => void;
  onDelete: (server: McpServerEntry) => void;
}

export function McpGroup({ servers: filtered, showActions, importing, onAdd, onImport, onEdit, onDelete }: McpGroupProps) {
  if (filtered.length === 0 && !showActions) return null;

  return (
    <div className="pb-1">
      <div className="flex items-center gap-1 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-text-subtle">
        <span>MCP Servers</span>
        <span className="text-text-subtle/60">{filtered.length}</span>
      </div>

      {filtered.map((s) => (
        <ContextMenu key={s.name}>
          <ContextMenuTrigger asChild>
            <button
              onClick={() => onEdit(s)}
              className="group flex w-full items-center gap-2 px-2 py-1.5 text-left transition-colors hover:bg-surface-elevated"
            >
              <Plug className="size-4 shrink-0 text-text-subtle" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium">{s.name}</span>
                <span className="block truncate text-[11px] text-text-subtle">{serverPreview(s)}</span>
              </span>
              <span className="shrink-0 rounded border border-border bg-surface-elevated px-1 py-px text-[9px] font-medium uppercase leading-none tracking-wide text-text-subtle">
                {s.transport}
              </span>
            </button>
          </ContextMenuTrigger>
          <ContextMenuContent className="w-40">
            <ContextMenuItem onClick={() => onEdit(s)}>Edit…</ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onClick={() => onDelete(s)}>Delete</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      ))}

      {filtered.length === 0 && showActions && (
        <p className="px-2 py-2 text-[11px] text-text-subtle">No MCP servers configured.</p>
      )}

      {showActions && (
        <div className="flex flex-col gap-1 px-2 pt-1.5">
          <button
            onClick={onAdd}
            className="flex items-center justify-center gap-1.5 rounded-md bg-primary py-1.5 text-[11px] font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="size-3.5" /> Add MCP server
          </button>
          <button
            onClick={onImport}
            disabled={importing}
            className={cn(
              "flex items-center justify-center gap-1.5 rounded-md border border-border py-1.5 text-[11px] text-text-secondary hover:bg-surface-elevated",
              importing && "opacity-50",
            )}
          >
            <Download className="size-3.5" /> {importing ? "Importing…" : "Import from Claude Code"}
          </button>
        </div>
      )}
    </div>
  );
}

export function serverPreview(s: McpServerEntry): string {
  const c = s.config;
  if (s.transport === "stdio" || !("url" in c)) {
    const stdio = c as { command?: string; args?: string[] };
    return [stdio.command, ...(stdio.args ?? [])].filter(Boolean).join(" ");
  }
  return (c as { url?: string }).url ?? "";
}
