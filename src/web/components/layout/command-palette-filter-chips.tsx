import { FileCode, Database, FolderOpen, Zap } from "lucide-react";

/** Metadata for each command group — label and icon for the filter chip */
const GROUP_META: Record<string, { label: string; icon: React.ElementType }> = {
  action: { label: "Actions", icon: Zap },
  file: { label: "Files", icon: FileCode },
  db: { label: "Database", icon: Database },
  fs: { label: "Filesystem", icon: FolderOpen },
};

interface CommandPaletteFilterChipsProps {
  /** Groups that have data (stable, pre-query) */
  availableGroups: string[];
  /** Count of filtered results per group (updates with query) */
  groupCounts: Record<string, number>;
  /** Currently active filter groups */
  activeFilters: Set<string>;
  /** Toggle a group filter on/off */
  onToggle: (group: string) => void;
}

export function CommandPaletteFilterChips({
  availableGroups,
  groupCounts,
  activeFilters,
  onToggle,
}: CommandPaletteFilterChipsProps) {
  if (availableGroups.length <= 1) return null;

  return (
    <div className="flex items-center gap-1.5 border-b border-border/50 px-3 py-1.5 overflow-x-auto">
      {availableGroups.map((group) => {
        const meta = GROUP_META[group];
        if (!meta) return null;
        const count = groupCounts[group] ?? 0;
        const isActive = activeFilters.has(group);
        const Icon = meta.icon;

        return (
          <button
            key={group}
            type="button"
            role="switch"
            aria-checked={isActive}
            aria-label={`Filter by ${meta.label}`}
            onClick={() => onToggle(group)}
            className={`inline-flex items-center gap-1 shrink-0 rounded-full border px-2.5 min-h-[44px] text-xs font-medium transition-colors ${
              isActive
                ? "bg-accent/15 border-accent text-accent"
                : "bg-surface border-border text-text-subtle hover:bg-surface-elevated"
            } ${count === 0 ? "opacity-50" : ""}`}
          >
            <Icon className="size-3" />
            <span>{meta.label}</span>
            <span className="text-[10px] opacity-70">({count})</span>
          </button>
        );
      })}
    </div>
  );
}
