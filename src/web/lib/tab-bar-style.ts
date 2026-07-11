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
    // Active accent bar sits on TOP (design: border-top 2px --accent) + elevated
    // --panel-2 fill. Vertical hairline between tabs via --border-soft (arbitrary
    // property so tailwind-merge can't drop it and it stays independent of the
    // top accent). Clean 41px pitch (no -mb-px) so the wrap horizontal rule lines up.
    base: "group flex items-center gap-1 px-3 h-[41px] whitespace-nowrap text-xs transition-colors border-t-2 [border-right:1px_solid_var(--border-soft)] cursor-grab active:cursor-grabbing",
    active: "border-t-primary bg-panel-2 text-primary",
    inactive: "border-t-transparent text-text-secondary hover:text-foreground hover:bg-panel/60",
    row: "flex items-center",
    add: "flex items-center justify-center h-[41px] w-10 shrink-0 sticky right-0 border-t-2 border-transparent text-text-secondary hover:text-foreground transition-colors",
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
  return cn(cfg.base, hasColorStyle ? "border-t-transparent" : isActive ? cfg.active : cfg.inactive);
}

export function tabRowClass(style: EditorTabStyle, tabWrap: boolean): string {
  // Default style only: in wrap mode draw a full-width horizontal rule at the
  // bottom of every 41px row via a repeating gradient on the row background
  // (spans the whole bar, not just under the tabs). Boxed/pill are floating
  // chips — no row rule. Single-row mode: fixed 41px, no rule.
  const wrapRule =
    style === "default"
      ? " [background:repeating-linear-gradient(to_bottom,transparent_0,transparent_40px,var(--border-soft)_40px,var(--border-soft)_41px)]"
      : "";
  return cn(
    TAB_STYLES[style].row,
    tabWrap ? "flex-wrap min-h-[41px]" + wrapRule : "h-[41px]",
  );
}

export function tabAddButtonClass(style: EditorTabStyle): string {
  return TAB_STYLES[style].add;
}
