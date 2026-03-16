import { X } from "lucide-react";
import type { Tab, TabType } from "@/stores/tab-store";
import { cn } from "@/lib/utils";

interface DraggableTabProps {
  tab: Tab;
  isActive: boolean;
  icon: React.ElementType;
  showDropBefore: boolean;
  onSelect: () => void;
  onClose: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  tabRef: (el: HTMLButtonElement | null) => void;
}

export function DraggableTab({
  tab, isActive, icon: Icon, showDropBefore, onSelect, onClose,
  onDragStart, onDragOver, onDragEnd, tabRef,
}: DraggableTabProps) {
  return (
    <div className="relative flex items-center">
      {showDropBefore && (
        <div className="absolute left-0 top-1 bottom-1 w-0.5 bg-primary rounded-full z-10" />
      )}
      <button
        ref={tabRef}
        draggable
        onClick={onSelect}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        className={cn(
          "group flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md whitespace-nowrap transition-colors",
          "border-b-2 -mb-[1px] cursor-grab active:cursor-grabbing",
          isActive
            ? "border-primary bg-surface text-foreground"
            : "border-transparent text-text-secondary hover:text-foreground hover:bg-surface-elevated",
        )}
      >
        <Icon className="size-4" />
        <span className="max-w-[120px] truncate">{tab.title}</span>
        {tab.closable && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); onClose(); }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); onClose(); } }}
            className="ml-1 opacity-0 group-hover:opacity-100 rounded-sm hover:bg-surface-elevated p-0.5 transition-opacity"
          >
            <X className="size-3" />
          </span>
        )}
      </button>
    </div>
  );
}
