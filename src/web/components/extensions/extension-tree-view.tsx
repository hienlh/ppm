import { useCallback, useState } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
import { useExtensionStore, type TreeItemUI } from "@/stores/extension-store";
import { cn } from "@/lib/utils";

interface ExtensionTreeViewProps {
  viewId: string;
  className?: string;
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
        <TreeNode key={item.id} item={item} depth={0} />
      ))}
    </div>
  );
}

function TreeNode({ item, depth }: { item: TreeItemUI; depth: number }) {
  const [expanded, setExpanded] = useState(item.collapsibleState === "expanded");
  const hasChildren = item.collapsibleState !== "none";

  const handleClick = useCallback(() => {
    if (hasChildren) {
      setExpanded((e) => !e);
    }
    if (item.command) {
      // Future: execute extension command via WS bridge
      console.log("[TreeView] execute command:", item.command);
    }
  }, [hasChildren, item.command]);

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
            <TreeNode key={child.id} item={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}
