import { cn } from "@/lib/utils";
import type { EditorTabStyle } from "@/stores/settings-store";

// Per-style className recipes for the editor tab bar. Logic lives in the
// components; this module only maps the chosen style → Tailwind classes so
// draggable-tab and tab-bar stay in sync (DRY).

interface TabStyleConfig {
  /** Tab button base (includes its border declaration). */
  base: string;
  /** Active tab colors (skipped when a connection-color style is applied). */
  active: string;
  /** Inactive tab colors. */
  inactive: string;
  /** Inner flex row spacing (gap + padding), excluding the wrap/height branch. */
  row: string;
  /** Sticky "+" button. */
  add: string;
}

const TAB_STYLES: Record<EditorTabStyle, TabStyleConfig> = {
  // Height standard: 41px (matches the sidebar top bar — the source of truth).
  // The default tab uses `border-b-2 -mb-px` to borrow the bar's 1px border so
  // the active underline sits exactly on the divider line.
  default: {
    // border-r = hairline divider between tabs (design: --border-soft). The
    // underline color must be per-side (border-b-*) so it doesn't tint the divider.
    base: "group flex items-center gap-1 px-3 h-[41px] whitespace-nowrap text-xs transition-colors border-b-2 -mb-px border-r border-r-border-soft cursor-grab active:cursor-grabbing",
    active: "border-b-primary bg-panel-2 text-primary",
    inactive: "border-b-transparent text-text-secondary hover:text-foreground hover:bg-panel/60",
    row: "flex items-center",
    add: "flex items-center justify-center h-[41px] w-10 shrink-0 sticky right-0 border-b-2 border-transparent text-text-secondary hover:text-foreground transition-colors",
  },
  boxed: {
    base: "group flex items-center gap-1.5 px-2.5 h-8 rounded-md whitespace-nowrap text-xs transition-colors border cursor-grab active:cursor-grabbing",
    active: "border-primary bg-primary/10 text-primary",
    inactive: "border-border text-text-secondary hover:border-text-subtle hover:text-foreground",
    row: "flex items-center gap-1.5 px-2 py-1.5",
    add: "flex items-center justify-center size-8 shrink-0 sticky right-0 rounded-md text-text-secondary hover:text-foreground hover:bg-surface-elevated transition-colors",
  },
  pill: {
    base: "group flex items-center gap-1.5 px-3 h-8 rounded-lg whitespace-nowrap text-xs transition-colors border cursor-grab active:cursor-grabbing",
    active: "border-border bg-surface-elevated text-foreground",
    inactive: "border-transparent text-text-secondary hover:bg-surface hover:text-foreground",
    row: "flex items-center gap-1 px-2 py-1.5",
    add: "flex items-center justify-center size-8 shrink-0 sticky right-0 rounded-lg text-text-secondary hover:text-foreground hover:bg-surface-elevated transition-colors",
  },
};

export function tabButtonClass(style: EditorTabStyle, isActive: boolean, hasColorStyle: boolean): string {
  const cfg = TAB_STYLES[style];
  return cn(cfg.base, hasColorStyle ? "border-b-transparent" : isActive ? cfg.active : cfg.inactive);
}

export function tabRowClass(style: EditorTabStyle, tabWrap: boolean): string {
  return cn(TAB_STYLES[style].row, tabWrap ? "flex-wrap min-h-[41px]" : "h-[41px]");
}

export function tabAddButtonClass(style: EditorTabStyle): string {
  return TAB_STYLES[style].add;
}
