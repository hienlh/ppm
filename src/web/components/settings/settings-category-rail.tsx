/**
 * Left pane of the split layout: every category visible at once, grouped.
 *
 * Nothing collapses and nothing hides behind a disclosure — the whole point of the split
 * layout is that a wide container can afford to show the full tree, so switching panes is one
 * click from anywhere.
 */

import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  SETTINGS_GROUPS, settingsCategoriesInGroup,
  type SettingsCategoryId,
} from "./settings-categories";

interface SettingsCategoryRailProps {
  active: SettingsCategoryId;
  onSelect: (id: SettingsCategoryId) => void;
}

export function SettingsCategoryRail({ active, onSelect }: SettingsCategoryRailProps) {
  return (
    <ScrollArea className="h-full">
      <nav className="p-2 space-y-4" aria-label="Settings categories">
        {SETTINGS_GROUPS.map((group) => {
          const categories = settingsCategoriesInGroup(group.id);
          if (categories.length === 0) return null;
          return (
            <div key={group.id} className="space-y-1">
              {group.label && (
                <h3 className="px-2 pt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {group.label}
                </h3>
              )}
              {categories.map((cat) => {
                const Icon = cat.icon;
                const isActive = cat.id === active;
                return (
                  <button
                    key={cat.id}
                    onClick={() => onSelect(cat.id)}
                    data-testid={`settings-rail-${cat.id}`}
                    aria-current={isActive ? "page" : undefined}
                    className={cn(
                      "w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-left cursor-pointer transition-colors",
                      isActive
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-accent/50 active:bg-accent",
                    )}
                  >
                    <Icon className={cn("size-4 shrink-0", isActive ? "text-foreground" : "text-muted-foreground")} />
                    <span className="text-sm truncate">{cat.label}</span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </nav>
    </ScrollArea>
  );
}
