import { useCallback, useRef, useState } from "react";
import { ChevronRight, ChevronDown } from "@/lib/icons";
import type { TreeItemUI } from "@/stores/extension-store";
import { extensionIcon } from "@/lib/extension-icons";
import { cn } from "@/lib/utils";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/adaptive-context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ExtensionTreeActionButton } from "./extension-tree-action-button";
import { ExtensionTreeRowMenu } from "./extension-tree-row-menu";
import { executeExtensionCommand, requestTreeExpand, safeRowUrl } from "./extension-tree-dispatch";

const LABEL_CLASS = "min-w-0 flex-1 truncate text-left text-xs transition-colors hover:text-primary";

/**
 * One row of an extension tree, one line high. The full text a row cannot fit is reachable two
 * ways: the tooltip on hover, and on a phone a long-press sheet that also carries the row's
 * actions with full-size targets. The row never starts a text selection on a long press
 * (`select-none`, no callout), and the press itself is the adaptive menu's, which disarms on
 * `touchcancel` so a scroll never opens it.
 */
export function ExtensionTreeNode({ item, depth, viewId }: { item: TreeItemUI; depth: number; viewId: string }) {
  const [expanded, setExpanded] = useState(false);
  const hasChildren = item.collapsibleState !== "none";
  const childrenLoaded = useRef(false);
  const url = safeRowUrl(item.url);
  const RowIcon = extensionIcon(item.icon);

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
    if (item.command) executeExtensionCommand(item.command, item.commandArgs);
  }, [handleToggle, item.command, item.commandArgs]);

  // From the menu: a link opens in a new tab inside the tap's own gesture; else the command runs.
  const handleOpen = useCallback(() => {
    if (url) window.open(url, "_blank", "noopener,noreferrer");
    else if (item.command) executeExtensionCommand(item.command, item.commandArgs);
  }, [url, item.command, item.commandArgs]);

  const label = url ? (
    // A worker cannot open a tab, so the row is the link and opens on the device that was tapped.
    <a href={url} target="_blank" rel="noopener noreferrer" className={LABEL_CLASS}>{item.label}</a>
  ) : (
    <button type="button" className={LABEL_CLASS} onClick={handleClick}>{item.label}</button>
  );

  const row = (
    <div
      className="group/node flex select-none items-center gap-1 py-1 transition-colors [-webkit-touch-callout:none] hover:bg-surface-elevated focus-within:bg-surface-elevated"
      style={{ paddingLeft: 8 + depth * 16, paddingRight: 8 }}
    >
      <button type="button" onClick={handleToggle} className="shrink-0 text-text-subtle transition-colors hover:text-foreground" tabIndex={hasChildren ? 0 : -1}>
        {hasChildren ? (
          expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />
        ) : (
          <span className="block size-3" />
        )}
      </button>

      {RowIcon && <RowIcon className="size-3.5 shrink-0 text-text-subtle" aria-hidden />}

      {item.color && (
        <span className="size-2 shrink-0 rounded-full border border-border" style={{ backgroundColor: item.color }} />
      )}

      {item.tooltip ? (
        <Tooltip>
          <TooltipTrigger asChild>{label}</TooltipTrigger>
          <TooltipContent side="right" align="start" className="max-w-xs whitespace-pre-line text-left">
            {item.tooltip}
          </TooltipContent>
        </Tooltip>
      ) : label}

      {item.description && <span className="ml-1 shrink-0 text-[10px] text-text-subtle">{item.description}</span>}

      {item.badge !== undefined && item.badge !== "" && (
        <span className="shrink-0 rounded bg-surface-elevated px-1 text-[9px] uppercase text-text-subtle">{item.badge}</span>
      )}

      {/* On hover or keyboard focus with a mouse; always on touch, where nothing hovers. */}
      {item.actions && item.actions.length > 0 && (
        <div className="flex shrink-0 items-center gap-0.5 can-hover:hidden can-hover:group-hover/node:flex can-hover:group-focus-within/node:flex">
          {item.actions.map((action) => (
            <ExtensionTreeActionButton key={action.command} action={action} />
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div role="treeitem" aria-expanded={hasChildren ? expanded : undefined}>
      <ContextMenu>
        <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
        <ExtensionTreeRowMenu item={item} url={url} onOpen={handleOpen} />
      </ContextMenu>

      {hasChildren && expanded && item.children && (
        <div role="group">
          {item.children.map((child) => (
            <ExtensionTreeNode key={child.id} item={child} depth={depth + 1} viewId={viewId} />
          ))}
        </div>
      )}
    </div>
  );
}
