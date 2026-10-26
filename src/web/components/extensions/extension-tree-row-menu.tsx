import { ExternalLink, ChevronRight, RefreshCw } from "@/lib/icons";
import type { TreeItemUI } from "@/stores/extension-store";
import { extensionIcon } from "@/lib/extension-icons";
import { ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuSeparator } from "@/components/ui/adaptive-context-menu";
import { executeExtensionCommand } from "./extension-tree-dispatch";

/**
 * What a row offers when it is long-pressed on a phone (a bottom sheet) or right-clicked on a
 * desktop: the full label and tooltip first, since the row itself shows one truncated line, then
 * the row's inline actions as full-width items, then Open.
 */
export function ExtensionTreeRowMenu({ item, url, onOpen }: { item: TreeItemUI; url?: string; onOpen: () => void }) {
  const actions = item.actions ?? [];
  const canOpen = !!url || !!item.command;
  return (
    <ContextMenuContent className="max-w-xs">
      <ContextMenuLabel>
        <div className="break-words font-medium">{item.label}</div>
        {item.description && <div className="mt-0.5 break-words text-xs font-normal text-text-subtle">{item.description}</div>}
        {item.tooltip && (
          <div className="mt-1 whitespace-pre-line break-words text-xs font-normal text-text-subtle">{item.tooltip}</div>
        )}
      </ContextMenuLabel>
      {actions.map((action) => {
        const Icon = extensionIcon(action.icon) ?? RefreshCw;
        return (
          <ContextMenuItem
            key={action.command}
            variant={action.icon === "trash" ? "destructive" : "default"}
            onClick={() => executeExtensionCommand(action.command, action.commandArgs)}
          >
            <Icon className="size-4" />
            {action.tooltip}
          </ContextMenuItem>
        );
      })}
      {canOpen && actions.length > 0 && <ContextMenuSeparator />}
      {canOpen && (
        <ContextMenuItem onClick={onOpen}>
          {url ? <ExternalLink className="size-4" /> : <ChevronRight className="size-4" />}
          Open
        </ContextMenuItem>
      )}
    </ContextMenuContent>
  );
}
