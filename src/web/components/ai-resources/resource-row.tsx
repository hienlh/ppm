import { memo } from "react";
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator,
} from "@/components/ui/adaptive-context-menu";
import { cn } from "@/lib/utils";
import { TYPE_ICON, ScopeBadge } from "./resource-visuals";
import type { AiResourceItem } from "@/lib/api-ai-resources";

interface ResourceRowProps {
  item: AiResourceItem;
  active: boolean;
  onOpen: (item: AiResourceItem) => void;
  onDuplicate: (item: AiResourceItem) => void;
  onDelete: (item: AiResourceItem) => void;
}

export const ResourceRow = memo(function ResourceRow({ item, active, onOpen, onDuplicate, onDelete }: ResourceRowProps) {
  const Icon = TYPE_ICON[item.type];
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          onClick={() => onOpen(item)}
          className={cn(
            "group relative flex w-full items-center gap-2 px-2 py-1.5 text-left transition-colors",
            active
              ? "bg-accent-wash text-foreground shadow-[inset_2px_0_0_var(--accent)]"
              : "hover:bg-surface-elevated",
            item.shadowed && "opacity-55",
          )}
        >
          <Icon className="size-4 shrink-0 text-text-subtle" strokeWidth={active ? 2.3 : 2} />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className={cn("truncate text-[13px] font-medium", item.shadowed && "line-through")}>
                {item.name}
              </span>
              {item.overrides ? (
                <span className="shrink-0 rounded bg-amber-500/15 px-1 py-px text-[9px] font-medium text-amber-400 leading-none">
                  overrides
                </span>
              ) : null}
              {item.shadowed ? (
                <span className="shrink-0 text-[9px] text-text-subtle">shadowed</span>
              ) : null}
            </span>
            {item.description ? (
              <span className="block truncate text-[11px] text-text-subtle">{item.description}</span>
            ) : null}
          </span>
          <ScopeBadge scope={item.scope} />
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem onClick={() => onOpen(item)}>
          {item.readOnly ? "Open (read-only)" : "Open / Edit"}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onDuplicate(item)}>Duplicate…</ContextMenuItem>
        {!item.readOnly && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onClick={() => onDelete(item)}>
              Delete
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
});
