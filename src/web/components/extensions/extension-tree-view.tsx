import { useCallback, useState } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import { useExtensionStore, type TreeItemUI } from "@/stores/extension-store";
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
function executeCommand(command: string) {
  window.dispatchEvent(new CustomEvent("ext:command:execute", {
    detail: { command },
  }));
}

/** Generic TreeView renderer for extension-contributed tree data */
export function ExtensionTreeView({ viewId, className }: ExtensionTreeViewProps) {
  const items = useExtensionStore((s) => s.treeViews[viewId]) ?? [];

  if (items.length === 0) {
    return (
      <div className={cn("flex items-center justify-center p-4 text-xs text-text-subtle", className)}>
        No items
      </div>
    );
  }

  return (
    <div className={cn("overflow-y-auto text-sm", className)} role="tree" aria-label={viewId}>
      {items.map((item) => (
        <TreeNode key={item.id} item={item} depth={0} viewId={viewId} />
      ))}
    </div>
  );
}

function TreeNode({ item, depth, viewId }: { item: TreeItemUI; depth: number; viewId: string }) {
  const [expanded, setExpanded] = useState(item.collapsibleState === "expanded");
  const hasChildren = item.collapsibleState !== "none";

  // Sync expanded state when store updates (e.g., after children arrive)
  const storeExpanded = item.collapsibleState === "expanded";
  if (storeExpanded && !expanded) setExpanded(true);

  const handleClick = useCallback(() => {
    if (hasChildren) {
      const willExpand = !expanded;
      setExpanded(willExpand);
      // Request children from server when expanding and no children loaded yet
      if (willExpand && (!item.children || item.children.length === 0)) {
        requestTreeExpand(viewId, item.id);
      }
    }
    if (item.command) {
      executeCommand(item.command);
    }
  }, [hasChildren, expanded, item.command, item.id, item.children, viewId]);

  const paddingLeft = 8 + depth * 16;

  return (
    <div role="treeitem" aria-expanded={hasChildren ? expanded : undefined}>
      <button
        className="flex items-center gap-1.5 w-full py-1 pr-2 text-left text-text-primary hover:bg-surface-elevated active:bg-surface-elevated transition-colors text-xs"
        style={{ paddingLeft }}
        onClick={handleClick}
        title={item.tooltip}
      >
        {/* Collapse/expand chevron */}
        <span className="size-4 shrink-0 flex items-center justify-center">
          {hasChildren ? (
            expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />
          ) : null}
        </span>

        {/* Icon */}
        {item.icon && (
          <span className="size-4 shrink-0 flex items-center justify-center text-text-subtle">
            {item.icon}
          </span>
        )}

        {/* Label + description */}
        <span className="truncate">{item.label}</span>
        {item.description && (
          <span className="ml-1 truncate text-text-subtle">{item.description}</span>
        )}
      </button>

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
