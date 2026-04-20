import { useState, useRef, useEffect } from "react";
import { X, Download } from "lucide-react";
import type { Tab, TabType } from "@/stores/tab-store";
import { cn } from "@/lib/utils";
import { isDarkColor } from "@/lib/color-utils";
import { notificationColor } from "@/stores/notification-store";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

interface DraggableTabProps {
  tab: Tab;
  isActive: boolean;
  icon: React.ElementType;
  showDropBefore: boolean;
  /** Notification type if unread (null = no unread). Controls badge color. */
  notificationType?: string | null;
  /** True when this chat tab is actively streaming an AI response */
  isStreaming?: boolean;
  onSelect: () => void;
  onClose: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onTouchStart?: (e: React.TouchEvent) => void;
  onTouchMove?: (e: React.TouchEvent) => void;
  onTouchEnd?: (e: React.TouchEvent) => void;
  tabRef: (el: HTMLButtonElement | null) => void;
  /** If provided, double-clicking the title enters inline rename mode */
  onRename?: (newTitle: string) => void;
  /** Context menu action handler — receives action name */
  onContextAction?: (action: string) => void;
  /** Tag color dot for chat tabs */
  tagColor?: string;
  /** Extra menu content injected before Close section */
  extraMenuContent?: React.ReactNode;
}

export function DraggableTab({
  tab, isActive, icon: Icon, showDropBefore, notificationType, isStreaming, onSelect, onClose,
  onDragStart, onDragOver, onDragEnd, onTouchStart, onTouchMove, onTouchEnd, tabRef, onRename, onContextAction,
  tagColor, extraMenuContent,
}: DraggableTabProps) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(tab.title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      setEditValue(tab.title);
      setTimeout(() => inputRef.current?.select(), 0);
    }
  }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps

  const commitRename = () => {
    setEditing(false);
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== tab.title && onRename) {
      onRename(trimmed);
    }
  };

  const tabColor = tab.metadata?.connectionColor as string | undefined;
  const colorStyle = tabColor
    ? {
        backgroundColor: isActive ? tabColor : `${tabColor}33`,
        color: isActive && isDarkColor(tabColor) ? "#fff" : undefined,
      }
    : undefined;

  const isFile = tab.type === "editor";

  const tabButton = (
    <button
      ref={tabRef}
      data-tab-item
      draggable={!editing}
      onClick={onSelect}
      onAuxClick={(e) => { if (e.button === 1 && tab.closable) { e.preventDefault(); onClose(); } }}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      style={colorStyle}
      className={cn(
        "group flex items-center gap-1 px-3 h-10 whitespace-nowrap text-xs transition-colors",
        "border-b-2 -mb-px cursor-grab active:cursor-grabbing",
        !colorStyle && (isActive
          ? "border-primary text-primary"
          : "border-transparent text-text-secondary hover:text-foreground"),
        colorStyle && "border-transparent",
      )}
    >
      {tagColor && (
        <span className="size-2 rounded-full shrink-0" style={{ backgroundColor: tagColor }} />
      )}
      <span className="relative">
        <Icon className="size-4" />
        {isStreaming ? (
          <span className="absolute -top-1 -right-1 size-2 rounded-full bg-emerald-500 animate-pulse motion-reduce:animate-none" />
        ) : notificationType && !isActive ? (
          <span className={cn("absolute -top-1 -right-1 size-2 rounded-full", notificationColor(notificationType))} />
        ) : null}
      </span>
      {editing ? (
        <input
          ref={inputRef}
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") setEditing(false);
            e.stopPropagation();
          }}
          onClick={(e) => e.stopPropagation()}
          className="max-w-[120px] bg-surface-elevated text-xs px-1 py-0.5 rounded border border-border outline-none focus:border-primary"
          autoFocus
        />
      ) : (
        <span
          className="max-w-[120px] truncate"
          onDoubleClick={(e) => {
            if (onRename) { e.stopPropagation(); setEditing(true); }
          }}
        >
          {tab.title}
        </span>
      )}
      {tab.closable && !editing && (
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); onClose(); } }}
          className="ml-1 can-hover:opacity-0 can-hover:group-hover:opacity-100 rounded-sm hover:bg-surface-elevated p-0.5 transition-opacity"
        >
          <X className="size-3" />
        </span>
      )}
    </button>
  );

  return (
    <div className="relative flex items-center">
      {showDropBefore && (
        <div className="absolute left-0 top-1 bottom-1 w-0.5 bg-primary rounded-full z-10" />
      )}
      {onContextAction ? (
        <ContextMenu>
          <ContextMenuTrigger asChild>
            {tabButton}
          </ContextMenuTrigger>
          <ContextMenuContent>
            {isFile && (
              <>
                <ContextMenuItem onClick={() => onContextAction("copy-path")}>
                  Copy Path
                </ContextMenuItem>
                <ContextMenuItem onClick={() => onContextAction("download")}>
                  <Download className="size-3.5 mr-2" />
                  Download
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={() => onContextAction("rename")}>
                  Rename
                </ContextMenuItem>
                <ContextMenuItem variant="destructive" onClick={() => onContextAction("delete")}>
                  Delete
                </ContextMenuItem>
                <ContextMenuSeparator />
              </>
            )}
            {extraMenuContent}
            {tab.closable && (
              <ContextMenuItem onClick={() => onContextAction("close")}>
                Close
              </ContextMenuItem>
            )}
            <ContextMenuItem onClick={() => onContextAction("close-others")}>
              Close Others
            </ContextMenuItem>
            <ContextMenuItem onClick={() => onContextAction("close-right")}>
              Close to the Right
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      ) : tabButton}
    </div>
  );
}
