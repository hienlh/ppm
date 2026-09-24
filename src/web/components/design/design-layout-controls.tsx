import { Columns2, MessageSquare, Palette } from "@/lib/icons";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { isDesignLayoutOverride, type DesignLayoutOverride, type DesignPane } from "@/lib/design/design-layout-mode";
import type { DesignLayoutControls } from "./design-tab-context";

/**
 * The desktop's layout controls: the Canvas | Chat toggle a single-pane tab shows in place
 * of the phone's bottom bar, and the menu that pins a layout.
 */

const PANES: { id: DesignPane; label: string; icon: typeof Palette }[] = [
  { id: "canvas", label: "Canvas", icon: Palette },
  { id: "chat", label: "Chat", icon: MessageSquare },
];

const LAYOUTS: { id: DesignLayoutOverride; label: string }[] = [
  { id: "auto", label: "Auto" },
  { id: "split", label: "Split" },
  { id: "canvas", label: "Canvas only" },
  { id: "chat", label: "Chat only" },
];

export function DesignPaneSwitch({ layout }: { layout: DesignLayoutControls }) {
  return (
    <div role="radiogroup" aria-label="Design pane" className="flex shrink-0 items-center gap-0.5 rounded-md bg-surface-elevated p-0.5">
      {PANES.map(({ id, label, icon: Icon }) => {
        const on = layout.pane === id;
        return (
          <button key={id} type="button" role="radio" aria-checked={on} onClick={() => layout.setPane(id)}
            className={cn(
              "flex h-7 items-center gap-1 rounded px-2 text-xs font-medium pointer-coarse:h-11 pointer-coarse:px-3",
              on ? "bg-background text-foreground shadow-sm" : "text-text-subtle hover:text-foreground",
            )}>
            <Icon className="size-3.5" /> {label}
          </button>
        );
      })}
    </div>
  );
}

export function DesignLayoutMenu({ layout, className }: { layout: DesignLayoutControls; className: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={className} aria-label="Layout" title="Layout">
          <Columns2 className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel className="text-xs text-text-subtle">Layout</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={layout.menuValue}
          onValueChange={(value) => { if (isDesignLayoutOverride(value)) layout.setOverride(value); }}>
          {LAYOUTS.map((item) => (
            <DropdownMenuRadioItem key={item.id} value={item.id} className="pointer-coarse:min-h-11">
              {item.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const headerBtn = "flex size-8 items-center justify-center rounded-md text-text-subtle hover:bg-surface-elevated hover:text-foreground pointer-coarse:size-11";

/**
 * Above the chat while it is the single pane on a desktop: the canvas's toolbar is hidden
 * with the canvas, so the way back to it has to live here.
 */
export function DesignChatPaneHeader({ layout }: { layout: DesignLayoutControls }) {
  return (
    <div className="flex min-h-9 shrink-0 items-center gap-2 border-b border-border bg-panel px-2">
      <DesignPaneSwitch layout={layout} />
      <span className="flex-1" />
      <DesignLayoutMenu layout={layout} className={headerBtn} />
    </div>
  );
}
