import { useMemo } from "react";
import { RefreshCw } from "@/lib/icons";
import { useExtensionStore } from "@/stores/extension-store";
import { extensionIcon } from "@/lib/extension-icons";
import { cn } from "@/lib/utils";
import { ExtensionTreeNode } from "./extension-tree-node";
import { executeExtensionCommand } from "./extension-tree-dispatch";

interface ExtensionTreeViewProps {
  viewId: string;
  className?: string;
}

/** Generic TreeView renderer for extension-contributed tree data */
export function ExtensionTreeView({ viewId, className }: ExtensionTreeViewProps) {
  const items = useExtensionStore((s) => s.treeViews[viewId]) ?? [];
  const contributions = useExtensionStore((s) => s.contributions);

  // Find view name & header actions from contributions
  const viewMeta = useMemo(() => {
    if (!contributions) return { name: viewId, headerActions: [] };
    // Find view name
    let name = viewId;
    const views = contributions.views;
    if (views) {
      for (const group of Object.values(views)) {
        const found = group.find((v) => v.id === viewId);
        if (found) { name = found.name; break; }
      }
    }
    // Find header actions from menus.view/title
    const headerActions: { command: string; title: string; icon?: string }[] = [];
    const viewTitleMenus = contributions.menus?.["view/title"];
    if (viewTitleMenus) {
      for (const menu of viewTitleMenus) {
        // Check "when" clause: view == viewId
        if (menu.when) {
          const match = menu.when.match(/view\s*==\s*(\S+)/);
          if (match && match[1] !== viewId) continue;
        }
        // Find command title
        const cmd = contributions.commands?.find((c) => c.command === menu.command);
        if (cmd) headerActions.push({ command: cmd.command, title: cmd.title, icon: cmd.icon });
      }
    }
    return { name, headerActions };
  }, [contributions, viewId]);

  return (
    <div className={cn("flex flex-col h-full", className)}>
      {/* Header — matches built-in DatabaseSidebar header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
        <span className="text-[10px] font-semibold text-text-subtle uppercase tracking-wider">
          {viewMeta.name}
        </span>
        <div className="flex items-center gap-0.5">
          {viewMeta.headerActions.map((action) => {
            const iconName = action.icon ?? inferIcon(action.command);
            const Icon = extensionIcon(iconName) ?? RefreshCw;
            return (
              <button
                key={action.command}
                onClick={() => executeExtensionCommand(action.command)}
                className="flex items-center justify-center size-5 rounded hover:bg-surface-elevated transition-colors text-text-subtle hover:text-foreground"
                title={action.title}
              >
                <Icon className="size-3.5" />
              </button>
            );
          })}
        </div>
      </div>

      {/* Tree content */}
      <div className="flex-1 overflow-y-auto min-h-0 py-1" role="tree" aria-label={viewId}>
        {items.length === 0 ? (
          <p className="px-4 py-6 text-xs text-text-subtle text-center">No items</p>
        ) : (
          items.map((item) => (
            <ExtensionTreeNode key={item.id} item={item} depth={0} viewId={viewId} />
          ))
        )}
      </div>
    </div>
  );
}

/** Infer icon name from command ID */
function inferIcon(command: string): string {
  if (command.includes("refresh")) return "refresh";
  if (command.includes("add") || command.includes("create") || command.includes("new")) return "plus";
  if (command.includes("delete") || command.includes("remove")) return "trash";
  if (command.includes("edit") || command.includes("update")) return "edit";
  if (command.includes("search") || command.includes("find")) return "search";
  return "refresh";
}
