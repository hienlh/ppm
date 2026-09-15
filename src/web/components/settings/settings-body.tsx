/**
 * The Settings shell, shared by every host: the floating window, the mobile tab, and (until it
 * moves out) the sidebar panel.
 *
 * Layout is decided by the shell's OWN width via `@container`, not by the viewport. The same
 * component therefore lands correctly in a 900px window, a 240px sidebar, and a phone tab
 * without any host passing a hint down — the way the process table already does it. Reading
 * `useIsMobile()` here would be wrong twice over: a narrow sidebar on a desktop is not mobile,
 * and a detached window on a tablet is not narrow.
 *
 * The content pane is mounted exactly once and never remounts while navigating. The narrow
 * layout's category list is an overlay above it rather than a sibling branch, so picking a
 * category cannot tear down and refetch the pane that was already there.
 */

import { useState } from "react";
import { ArrowLeft } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  DEFAULT_SETTINGS_CATEGORY, settingsCategory,
  type SettingsCategoryId,
} from "./settings-categories";
import { SettingsCategoryRail } from "./settings-category-rail";
import { SettingsCategoryList } from "./settings-category-list";
import { SettingsSectionContent } from "./settings-section-content";

export interface SettingsBodyProps {
  /**
   * Category to open on. Present when a host remembers where the user was (a window payload)
   * or deep-links into a pane; its presence also skips the narrow layout's list, so a
   * deep link lands on the pane instead of the index.
   */
  initialCategory?: SettingsCategoryId;
  /** Fires on every category change so a host can persist the position. */
  onCategoryChange?: (category: SettingsCategoryId) => void;
}

export function SettingsBody({ initialCategory, onCategoryChange }: SettingsBodyProps) {
  const [active, setActive] = useState<SettingsCategoryId>(initialCategory ?? DEFAULT_SETTINGS_CATEGORY);
  // Narrow layout only: is the index covering the pane? A deep link opens straight on the pane.
  const [showList, setShowList] = useState(initialCategory === undefined);

  const category = settingsCategory(active);
  const Icon = category.icon;

  function select(id: SettingsCategoryId) {
    setActive(id);
    // Also cleared when picking from the rail: if the container later shrinks, a stale list
    // overlay would otherwise cover the pane the user just chose.
    setShowList(false);
    onCategoryChange?.(id);
  }

  return (
    <div className="@container h-full w-full" data-testid="settings-window" data-category={active}>
      <div className="h-full w-full flex">
        {/* Split layout only — the narrow layout navigates through the overlay instead. */}
        <aside
          className="hidden @[640px]:flex @[640px]:flex-col w-[210px] shrink-0 border-r border-border min-h-0"
          data-testid="settings-rail"
        >
          <SettingsCategoryRail active={active} onSelect={select} />
        </aside>

        <div className="relative flex-1 min-w-0">
          <div className="h-full flex flex-col min-h-0">
            <div className="shrink-0 flex items-center gap-2 px-2 py-2.5 @[640px]:px-4">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Back to settings list"
                className="size-9 shrink-0 cursor-pointer @[640px]:hidden"
                onClick={() => setShowList(true)}
              >
                <ArrowLeft className="size-4" />
              </Button>
              <Icon className="size-4 text-muted-foreground shrink-0" />
              <h2 className="text-sm font-semibold truncate" data-testid="settings-pane-title">
                {category.label}
              </h2>
            </div>
            <Separator />
            <ScrollArea className="flex-1 min-h-0">
              <div className="p-4 pb-8">
                <SettingsSectionContent category={active} />
              </div>
            </ScrollArea>
          </div>

          {showList && (
            <div
              className="absolute inset-0 z-10 bg-background flex flex-col min-h-0 @[640px]:hidden"
              data-testid="settings-index"
            >
              <div className="shrink-0 px-4 py-3">
                <h2 className="text-sm font-semibold">Settings</h2>
              </div>
              <Separator />
              <div className="flex-1 min-h-0">
                <SettingsCategoryList onSelect={select} />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
