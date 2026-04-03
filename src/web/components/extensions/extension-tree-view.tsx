import { useCallback, useState, useRef, useMemo } from "react";
import { ChevronRight, ChevronDown, RefreshCw, Pencil, Trash2, Plus, Search } from "lucide-react";
import { useExtensionStore, type TreeItemUI, type TreeItemAction } from "@/stores/extension-store";
import { cn } from "@/lib/utils";

interface ExtensionTreeViewProps {
  viewId: string;
  className?: string;
}

/** Dispatch a tree:expand request to fetch children from the server */
function requestTreeExpand(viewId: string, itemId: string) {
  window.dispatchEvent(new CustomEvent("ext:tree:expand", {
    detail: { viewId, itemId },
  }));
}

/** Dispatch a command:execute request via the WS bridge */
function executeCommand(command: string, args?: unknown[]) {
  window.dispatchEvent(new CustomEvent("ext:command:execute", {
    detail: { command, args },
  }));
}

const ACTION_ICONS: Record<string, React.ElementType> = {
  refresh: RefreshCw,
  edit: Pencil,
  trash: Trash2,
  plus: Plus,
  search: Search,
};

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
            const Icon = ACTION_ICONS[iconName] ?? RefreshCw;
            return (
              <button
                key={action.command}
                onClick={() => executeCommand(action.command)}
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
            <TreeNode key={item.id} item={item} depth={0} viewId={viewId} />
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

function TreeNode({ item, depth, viewId }: { item: TreeItemUI; depth: number; viewId: string }) {
  const [expanded, setExpanded] = useState(false);
  const hasChildren = item.collapsibleState !== "none";
  const childrenLoaded = useRef(false);

  // When children arrive from server, auto-expand once
  if (item.children && item.children.length > 0 && !childrenLoaded.current) {
    childrenLoaded.current = true;
    if (!expanded) setExpanded(true);
  }

  const handleToggle = useCallback(() => {
    if (!hasChildren) return;
    const willExpand = !expanded;
    setExpanded(willExpand);
    if (willExpand && (!item.children || item.children.length === 0)) {
      requestTreeExpand(viewId, item.id);
    }
  }, [hasChildren, expanded, item.id, item.children, viewId]);

  const handleClick = useCallback(() => {
    handleToggle();
    if (item.command) {
      executeCommand(item.command, item.commandArgs);
    }
  }, [handleToggle, item.command, item.commandArgs]);

  const paddingLeft = 8 + depth * 16;

  return (
    <div role="treeitem" aria-expanded={hasChildren ? expanded : undefined}>
      <div
        className={cn("group/node flex items-center gap-1 py-1 hover:bg-surface-elevated transition-colors")}
        style={{ paddingLeft, paddingRight: 8 }}
      >
        {/* Expand chevron */}
        <button
          onClick={handleToggle}
          className="shrink-0 text-text-subtle hover:text-foreground transition-colors"
        >
          {hasChildren ? (
            expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />
          ) : (
            <span className="size-3" />
          )}
        </button>

        {/* Color dot */}
        {item.color && (
          <span
            className="shrink-0 size-2 rounded-full border border-border"
            style={{ backgroundColor: item.color }}
          />
        )}

        {/* Label — click to toggle or execute command */}
        <button
          className="flex-1 text-left text-xs truncate hover:text-primary transition-colors"
          onClick={handleClick}
        >
          {item.label}
        </button>

        {/* Description (column type info) */}
        {item.description && (
          <span className="shrink-0 ml-1 text-text-subtle text-[10px]">{item.description}</span>
        )}

        {/* Badge (PG/DB) */}
        {item.badge && (
          <span className="shrink-0 text-[9px] text-text-subtle uppercase px-1 rounded bg-surface-elevated">
            {item.badge}
          </span>
        )}

        {/* Action buttons (visible on hover) */}
        {item.actions && item.actions.length > 0 && (
          <div className="hidden group-hover/node:flex items-center gap-0.5 shrink-0">
            {item.actions.map((action) => (
              <ActionButton key={action.command} action={action} />
            ))}
          </div>
        )}
      </div>

      {/* Children */}
      {hasChildren && expanded && item.children && (
        <div role="group">
          {item.children.map((child) => (
            <TreeNode key={child.id} item={child} depth={depth + 1} viewId={viewId} />
          ))}
        </div>
      )}
    </div>
  );
}

function ActionButton({ action }: { action: TreeItemAction }) {
  const [spinning, setSpinning] = useState(false);
  const Icon = ACTION_ICONS[action.icon] ?? RefreshCw;
  const isTrash = action.icon === "trash";

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (action.icon === "refresh") {
      setSpinning(true);
      setTimeout(() => setSpinning(false), 1000);
    }
    executeCommand(action.command, action.commandArgs);
  }, [action]);

  return (
    <button
      onClick={handleClick}
      className={cn(
        "p-0.5 text-text-subtle transition-colors",
        isTrash ? "hover:text-red-500" : "hover:text-foreground",
      )}
      title={action.tooltip}
    >
      <Icon className={cn("size-3", spinning && "animate-spin")} />
    </button>
  );
}
