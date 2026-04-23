import { Save, Undo2 } from "lucide-react";

interface SaveBarProps {
  pendingCount: number;
  onSave: () => void;
  onDiscard: () => void;
}

/**
 * Floating save bar shown when there are pending cell edits.
 * Save with click or Mod+Enter. Discard with Escape.
 */
export function GlideSaveBar({ pendingCount, onSave, onDiscard }: SaveBarProps) {
  if (pendingCount === 0) return null;

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 border-t border-amber-400/50 bg-amber-50 dark:bg-amber-950/30 shrink-0 text-xs">
      <span className="text-amber-700 dark:text-amber-300 font-medium">
        {pendingCount} pending edit{pendingCount > 1 ? "s" : ""}
      </span>
      <div className="flex-1" />
      <button type="button" onClick={onDiscard}
        className="flex items-center gap-1 px-2 py-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
        <Undo2 className="size-3" /> Discard
      </button>
      <button type="button" onClick={onSave}
        className="flex items-center gap-1 px-2 py-0.5 rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors">
        <Save className="size-3" /> Save
        <kbd className="ml-1 text-[9px] opacity-70">⌘↵</kbd>
      </button>
    </div>
  );
}
