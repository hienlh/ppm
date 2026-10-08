/**
 * The status bar's window dock: one chip per floating window, in the order they were opened,
 * like a taskbar. Three states read at a glance — in front (tinted, long accent bar), open
 * behind (short bar), minimized (no bar, dimmed tile) — plus a pulsing dot while an AI turn
 * runs in the window.
 *
 * Clicking the chip in front minimizes its window; any other chip brings its window forward,
 * from the dock if need be. Squeezed, chips give up their titles and then fold into `+N`
 * (`planDock`); `+N`, or a right-click anywhere on the dock, lists every window.
 *
 * The chip widths `planDock` needs come from a second, invisible row of full-size chips:
 * the visible row is already squeezed, so it cannot say how wide a chip would like to be.
 */

import { memo, useLayoutEffect, useRef, useState } from "react";
import { ChevronUp } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { useBusyWindowIds, useWindowMeta } from "./use-window-meta";
import { windowTitle } from "./window-content-registry";
import { planDock, type DockLayout } from "./window-dock-layout";
import { WindowDockList } from "./window-dock-list";
import { isPipOnlyWindow } from "./window-pip-registry";
import { frontWindowId, useWindowStore, windowsInOpenOrder, type WindowRuntimeState } from "./window-store";
import { WindowBusyDot, WindowTile } from "./window-title-identity";

/** Past this many chips the row stops being scannable; the rest goes into `+N`. */
const MAX_CHIPS = 8;
const CHIP_GAP = 2;
/** A chip without its title: 16px tile + 5px padding each side. */
const ICON_CHIP_WIDTH = 26;

type ChipState = "front" | "behind" | "min";

export const WindowDock = memo(function WindowDock() {
  const windows = useWindowStore((s) => s.windows);
  // A window carrying a tab into picture-in-picture is never on screen; it is not one the
  // user opened.
  const list = windowsInOpenOrder(windows).filter((w) => !isPipOnlyWindow(w.id));
  const frontId = frontWindowId(windows);
  const frontIndex = list.findIndex((w) => w.id === frontId);
  const busy = useBusyWindowIds(list);

  const rootRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<DockLayout>({ mode: "full", hidden: [] });
  const [listOpen, setListOpen] = useState(false);

  const key = list.map((w) => w.id).join(",");
  useLayoutEffect(() => {
    const root = rootRef.current;
    const measure = measureRef.current;
    if (!root || !measure) return;
    const replan = () => {
      const chips = [...measure.querySelectorAll<HTMLElement>("[data-chip]")];
      const more = measure.querySelector<HTMLElement>("[data-more]");
      const style = getComputedStyle(root);
      const available = root.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const next = planDock({
        available,
        fullWidths: chips.map((c) => c.offsetWidth),
        iconWidth: ICON_CHIP_WIDTH,
        gap: CHIP_GAP,
        // +2: the button's own left margin.
        moreWidth: (more?.offsetWidth ?? 40) + 2,
        frontIndex,
        maxChips: MAX_CHIPS,
      });
      setLayout((prev) => (prev.mode === next.mode && prev.hidden.join() === next.hidden.join() ? prev : next));
    };
    replan();
    // The root follows the bar's width; the measuring row follows the titles.
    const observer = new ResizeObserver(replan);
    observer.observe(root);
    observer.observe(measure);
    return () => observer.disconnect();
  }, [key, frontIndex]);

  if (list.length === 0) return null;

  const stateOf = (w: WindowRuntimeState): ChipState =>
    w.id === frontId ? "front" : w.state === "minimized" ? "min" : "behind";
  const hidden = new Set(layout.hidden);
  const hiddenBusy = list.some((w, i) => hidden.has(i) && busy.has(w.id));

  return (
    <div
      ref={rootRef}
      role="toolbar"
      aria-label="Windows"
      onContextMenu={(e) => { e.preventDefault(); setListOpen(true); }}
      className="relative flex h-full min-w-0 flex-1 basis-0 items-center gap-0.5 overflow-hidden border-l border-border-soft pl-2.5 font-sans"
    >
      {list.map((w, i) => hidden.has(i) ? null : (
        <DockChip
          key={w.id}
          win={w}
          state={stateOf(w)}
          showTitle={layout.mode === "full" || (layout.mode === "compact" && w.id === frontId)}
          busy={busy.has(w.id)}
        />
      ))}
      {layout.hidden.length > 0 && (
        <MoreButton count={layout.hidden.length} busy={hiddenBusy} expanded={listOpen} onClick={() => setListOpen(!listOpen)} />
      )}

      {/* Invisible, full-size twins of the chips: the widths `planDock` works from. */}
      <div ref={measureRef} aria-hidden="true" className="pointer-events-none invisible absolute left-0 top-0 flex gap-0.5 whitespace-nowrap">
        {list.map((w) => <DockChip key={w.id} win={w} state={stateOf(w)} showTitle busy={false} measuring />)}
        <MoreButton count={list.length} busy={false} expanded={false} measuring />
      </div>

      <WindowDockList open={listOpen} onOpenChange={setListOpen} anchorRef={rootRef} windows={list} frontId={frontId} />
    </div>
  );
});

function DockChip({ win, state, showTitle, busy, measuring }: {
  win: WindowRuntimeState;
  state: ChipState;
  showTitle: boolean;
  busy: boolean;
  measuring?: boolean;
}) {
  const meta = useWindowMeta(win);
  const title = meta.title || windowTitle(win.kind, win.payload);
  const label = `${title}${state === "min" ? " (minimized)" : ""}${busy ? " · working" : ""}`;
  return (
    <button
      type="button"
      data-chip=""
      tabIndex={measuring ? -1 : undefined}
      title={label}
      aria-label={label}
      aria-pressed={state !== "min"}
      onClick={() => useWindowStore.getState().activateFromDock(win.id)}
      className={cn(
        "relative flex h-[22px] max-w-[168px] items-center gap-1.5 rounded-md text-[11.5px] font-medium leading-none transition-colors",
        "can-hover:hover:bg-surface-hover can-hover:hover:text-text",
        showTitle ? "pl-1 pr-2" : "px-[5px]",
        // The front chip is the one that gives way first, so it is never folded away.
        state === "front" ? "min-w-[26px] shrink bg-accent-wash text-text" : "shrink-0",
        state === "behind" && "text-text-2",
        state === "min" && "text-text-3",
      )}
    >
      <WindowTile icon={meta.icon} tone={meta.tone} size="sm" filled={meta.filled} muted={state === "min"}>
        {busy && <WindowBusyDot />}
      </WindowTile>
      {showTitle && <span className="min-w-0 truncate">{title}</span>}
      {state !== "min" && (
        <span
          aria-hidden="true"
          className={cn(
            "absolute bottom-0 left-1/2 h-[2px] -translate-x-1/2 rounded-full transition-[width,background-color]",
            state === "front" ? "w-[18px] bg-primary" : "w-1.5 bg-text-3",
          )}
        />
      )}
    </button>
  );
}

function MoreButton({ count, busy, expanded, onClick, measuring }: {
  count: number;
  busy: boolean;
  expanded: boolean;
  onClick?: () => void;
  measuring?: boolean;
}) {
  return (
    <button
      type="button"
      data-more=""
      tabIndex={measuring ? -1 : undefined}
      title={`${count} more window${count === 1 ? "" : "s"}`}
      aria-label={`${count} more window${count === 1 ? "" : "s"}`}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      onClick={onClick}
      className={cn(
        "relative ml-0.5 flex h-[22px] shrink-0 items-center gap-0.5 rounded-md border pl-2 pr-1.5 text-[11px] font-semibold leading-none transition-colors",
        expanded
          ? "border-accent-wash-border bg-accent-wash text-text"
          : "border-border-soft bg-panel-2 text-text-2 can-hover:hover:border-accent-wash-border can-hover:hover:bg-accent-wash can-hover:hover:text-text",
      )}
    >
      +{count}
      <ChevronUp className={cn("size-3 transition-transform", expanded && "rotate-180")} />
      {busy && <WindowBusyDot className="-right-0.5 -top-0.5" />}
    </button>
  );
}
