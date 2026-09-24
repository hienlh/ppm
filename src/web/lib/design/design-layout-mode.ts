/**
 * How a design tab lays out its chat and canvas, decided from the tab's own width rather
 * than the viewport: a desktop split into two or three panels gives the tab 450-650px, which
 * is a narrow tab on a wide screen, not a phone.
 *
 * Pure on purpose. The component only measures and renders; every decision is here, where it
 * can be tested without a DOM.
 */

export const DESIGN_LAYOUT_OVERRIDES = ["auto", "split", "canvas", "chat"] as const;
/** The layout the user picked: `auto` follows the width, the rest are pinned. */
export type DesignLayoutOverride = (typeof DESIGN_LAYOUT_OVERRIDES)[number];
export type DesignPane = "canvas" | "chat";

/**
 * Auto mode splits at or above {@link SPLIT_ENTER_WIDTH} and goes single-pane below
 * {@link SPLIT_LEAVE_WIDTH}. Between the two it keeps what it had, so dragging a panel
 * divider across one threshold does not flip the layout on every pixel.
 */
export const SPLIT_ENTER_WIDTH = 940;
export const SPLIT_LEAVE_WIDTH = 860;

export function isDesignLayoutOverride(value: unknown): value is DesignLayoutOverride {
  return typeof value === "string" && (DESIGN_LAYOUT_OVERRIDES as readonly string[]).includes(value);
}

/**
 * Auto mode's split decision for a measured width. A width of 0 is not a measurement: a tab
 * the tab pool has parked (another project is showing, or the tab is not the visible one)
 * measures 0 wide, and it must come back in the layout it left with.
 */
export function nextAutoSplit(width: number, wasSplit: boolean): boolean {
  if (!Number.isFinite(width) || width <= 0) return wasSplit;
  if (width >= SPLIT_ENTER_WIDTH) return true;
  if (width < SPLIT_LEAVE_WIDTH) return false;
  return wasSplit;
}

/** The pane a single-pane tab opens on: the canvas, unless the user pinned the chat. */
export function initialDesignPane(override: DesignLayoutOverride): DesignPane {
  return override === "chat" ? "chat" : "canvas";
}

export interface DesignLayoutInput {
  override: DesignLayoutOverride;
  /** Phone viewport: always one pane, switched from the thumb-zone bar. */
  isPhone: boolean;
  /** Auto mode's current answer, from {@link nextAutoSplit}. */
  autoSplit: boolean;
  /** The pane last chosen for single-pane display. */
  pane: DesignPane;
  /** The canvas covers the whole window. */
  expanded: boolean;
}

export interface DesignLayout {
  split: boolean;
  /** The pane on screen when not split; always the canvas while expanded. */
  pane: DesignPane;
  /** What switches panes: the phone's bottom bar, the desktop toggle, or nothing. */
  switcher: "phone" | "toolbar" | null;
  /** The layout menu's checked item, which follows what is on screen. */
  menuValue: DesignLayoutOverride;
  expanded: boolean;
}

export function resolveDesignLayout(input: DesignLayoutInput): DesignLayout {
  const { override, isPhone, autoSplit, expanded } = input;
  // An expanded canvas lives inside the canvas pane, so that pane has to be the visible one.
  const pane: DesignPane = expanded ? "canvas" : input.pane;
  // A phone ignores a pinned split: two panes do not fit, and the pin belongs to this device's
  // wider windows as much as to its narrow one.
  const split = !isPhone && (override === "split" || (override === "auto" && autoSplit));
  const switcher = expanded || split ? null : isPhone ? "phone" : "toolbar";
  // A pinned single pane still lets the user peek at the other pane; the menu then names the
  // pane actually shown, so it never claims "Canvas only" over a visible chat.
  const menuValue = override === "canvas" || override === "chat" ? pane : override;
  return { split, pane, switcher, menuValue, expanded };
}
