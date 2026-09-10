/**
 * Narrow-container layout: one column, list first and pane second.
 *
 * A rail plus a content pane cannot both be usable below ~640px, so instead of shrinking both
 * this drills down — the list fills the container, picking a row replaces it, and Back returns.
 * Group labels stay as headings so the list is still scannable at a glance.
 */

import { ChevronRight } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  SETTINGS_GROUPS, settingsCategoriesInGroup,
  type SettingsCategoryId,
} from "./settings-categories";

export function SettingsCategoryList({ onSelect }: { onSelect: (id: SettingsCategoryId) => void }) {
  return (
    <ScrollArea className="h-full">
      <nav className="p-3 space-y-5" aria-label="Settings categories">
        {SETTINGS_GROUPS.map((group) => {
          const categories = settingsCategoriesInGroup(group.id);
          if (categories.length === 0) return null;
          return (
            <div key={group.id} className="space-y-1">
              {group.label && (
                <h3 className="px-1 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {group.label}
                </h3>
              )}
              {categories.map((cat) => {
                const Icon = cat.icon;
                return (
                  <button
                    key={cat.id}
                    onClick={() => onSelect(cat.id)}
                    data-testid={`settings-index-${cat.id}`}
                    className="w-full flex items-center gap-3 px-2.5 py-3 rounded-lg text-left cursor-pointer group hover:bg-accent/50 active:bg-accent transition-colors"
                  >
                    <div className="size-10 rounded-md bg-muted flex items-center justify-center shrink-0 group-hover:bg-accent">
                      <Icon className="size-4 text-muted-foreground" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{cat.label}</p>
                      <p className="text-xs text-muted-foreground truncate">{cat.subtitle}</p>
                    </div>
                    <ChevronRight className="size-4 text-muted-foreground shrink-0" />
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
