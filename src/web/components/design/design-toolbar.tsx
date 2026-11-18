import { useLayoutEffect, useRef, useState, type ElementType, type ReactNode } from "react";
import {
  Columns2, Download, History, Maximize2, MessageSquare, MessageSquarePlus, Monitor, MoreHorizontal, MousePointerClick, Move,
  Presentation, RefreshCw, Send, Share2, SlidersHorizontal, Smartphone, Sparkles, Tablet, Undo2,
} from "@/lib/icons";
import { toast } from "sonner";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { runDesignSystemSetup } from "@/lib/design/run-design-system-setup";
import { DEVICE_FRAMES, type DeviceFrameId } from "./canvas/device-frame-presets";
import type { DesignTabContextValue } from "./design-tab-context";
import type { DesignCanvasState } from "./canvas/use-design-canvas";
import type { DesignCommentsFeature } from "./comments/use-design-comments-feature";
import type { DesignTweaksFeature } from "./tweaks/use-design-tweaks";
import type { CanvasTransformFeature } from "./transform/use-canvas-transform";
import type { DesignUndoFeature } from "./transform/design-undo-stack";
import type { DesignExportFeature } from "./export/use-design-export";
import { ExportMenuButton } from "./export/export-menu";
import { DesignLayoutMenu, DesignPaneSwitch } from "./design-layout-controls";
import type { DesignVariantsFeature } from "./variants/use-design-variants";
import { DesignVariantMenu } from "./variants/design-variant-controls";
import { ToolbarBadge } from "./design-toolbar-badge";
import type { DesignShareFeature } from "./share/design-share-dialog";

/**
 * The canvas toolbar and its registry.
 *
 * Features add a button by appending to {@link DESIGN_TOOLBAR_ITEMS}; nothing else in this
 * file needs to change. `bar` items get a button on desktop, `more` items live in the
 * overflow menu, and a `bar` item with `renderBar` draws its own control (a dropdown). On a
 * phone every item is in the More sheet (the thumb-zone bar only holds Canvas / Chat / More),
 * which renders the same list through `DesignToolbarList` and calls `run`.
 */

export interface DesignToolbarContext extends DesignTabContextValue {
  canvas: DesignCanvasState;
  frame: DeviceFrameId;
  setFrame: (frame: DeviceFrameId) => void;
  historyOpen: boolean;
  toggleHistory: () => void;
  comments: DesignCommentsFeature;
  tweaks: DesignTweaksFeature;
  transform: CanvasTransformFeature;
  undo: DesignUndoFeature;
  exports: DesignExportFeature;
  variants: DesignVariantsFeature;
  share: DesignShareFeature;
}

export interface DesignToolbarItem {
  id: string;
  label: string;
  icon: ElementType;
  placement: "bar" | "more";
  isActive?: (ctx: DesignToolbarContext) => boolean;
  isDisabled?: (ctx: DesignToolbarContext) => boolean;
  /** Left out of the bar, the menu and the phone sheet while true. */
  isHidden?: (ctx: DesignToolbarContext) => boolean;
  /** A count shown on the button, e.g. open comments; nothing when 0 or null. */
  badge?: (ctx: DesignToolbarContext) => number | null;
  /** Stays in the bar when a narrow pane moves the other buttons into More. */
  keepInBar?: boolean;
  /** Desktop bar only: a control of its own in place of the plain button. */
  renderBar?: (ctx: DesignToolbarContext, className: string) => ReactNode;
  run: (ctx: DesignToolbarContext) => void;
}

export const DESIGN_TOOLBAR_ITEMS: DesignToolbarItem[] = [
  { id: "reload", label: "Reload canvas", icon: RefreshCw, placement: "bar", run: (ctx) => ctx.canvas.reload() },
  {
    id: "history", label: "Version history", icon: History, placement: "bar",
    isActive: (ctx) => ctx.historyOpen, run: (ctx) => ctx.toggleHistory(),
  },
  {
    // Targets the design's own app, not necessarily the tab it was clicked from: opens (or
    // creates) that app's showcase design and auto-sends the setup brief there.
    id: "design-system", label: "Set up design system", icon: Sparkles, placement: "more",
    run: (ctx) => {
      void runDesignSystemSetup(ctx.projectName, ctx.design.system)
        .catch((e: Error) => toast.error("Could not start setup", { description: e.message }));
    },
  },
  {
    // Picking needs element ids, which a file served without instrumentation does not have.
    id: "select", label: "Select element", icon: MousePointerClick, placement: "bar",
    isActive: (ctx) => ctx.comments.picker.on,
    isDisabled: (ctx) => ctx.canvas.bridge.ready?.instrumented === false,
    run: (ctx) => ctx.comments.picker.setOn(!ctx.comments.picker.on),
  },
  {
    id: "comments", label: "Comments", icon: MessageSquarePlus, placement: "bar",
    isActive: (ctx) => ctx.comments.panelOpen,
    badge: (ctx) => ctx.comments.openCount || null,
    run: (ctx) => ctx.comments.togglePanel(),
  },
  {
    // Opens the Share dialog; with PPM sign-in off it explains why nothing can be shared.
    id: "share", label: "Share for review", icon: Share2, placement: "bar",
    isActive: (ctx) => ctx.share.open, run: (ctx) => ctx.share.setOpen(true),
  },
  {
    // Offered whenever design.json parses; with no tweaks declared the panel asks the AI for some.
    id: "tweaks", label: "Tweaks", icon: SlidersHorizontal, placement: "bar",
    isHidden: (ctx) => !ctx.tweaks.available,
    isActive: (ctx) => ctx.tweaks.panelOpen,
    badge: (ctx) => ctx.tweaks.dirtyCount || null,
    run: (ctx) => ctx.tweaks.togglePanel(),
  },
  {
    // Writes need element ids and a quiet chat: an agent editing the same file would race it.
    id: "move", label: "Move and resize", icon: Move, placement: "bar",
    isActive: (ctx) => ctx.transform.moveOn,
    isDisabled: (ctx) => !ctx.transform.moveOn && ctx.transform.disabled,
    run: (ctx) => ctx.transform.toggle(),
  },
  {
    // Reverts the newest canvas write only, exactly; AI turns since then stay.
    id: "undo", label: "Undo canvas edit", icon: Undo2, placement: "bar",
    isDisabled: (ctx) => !ctx.undo.canUndo,
    run: (ctx) => ctx.undo.undo(),
  },
  {
    // Desktop: a dropdown of its own. Phone: the More sheet's row opens the export sheet.
    id: "export", label: "Export", icon: Download, placement: "bar",
    renderBar: (ctx, className) => <ExportMenuButton key="export" feature={ctx.exports} className={className} />,
    run: (ctx) => ctx.exports.setSheetOpen(true),
  },
  {
    // Starts a new, ordinary chat with the brief and a screenshot of the variant on screen
    // as an editable draft; never the design chat. A bar button (not More) because this is
    // the primary path into real code — Export stays for building on another machine.
    id: "build-in-new-chat", label: "Build in new chat", icon: Send, placement: "bar",
    run: (ctx) => ctx.exports.buildInNewChat(),
  },
  {
    // The canvas over the whole window; the chat keeps running underneath.
    id: "expand", label: "Expand canvas", icon: Maximize2, placement: "bar",
    isActive: (ctx) => ctx.layout.expanded,
    run: (ctx) => ctx.layout.setExpanded(!ctx.layout.expanded),
  },
  {
    // Desktop only, as a menu of its own: a phone always shows one pane. Hidden while the
    // canvas is expanded, where hiding the canvas pane would take the expanded view with it.
    id: "layout", label: "Layout", icon: Columns2, placement: "bar", keepInBar: true,
    isHidden: (ctx) => ctx.isMobile || ctx.layout.expanded || ctx.layout.windowed,
    renderBar: (ctx, className) => <DesignLayoutMenu key="layout" layout={ctx.layout} className={className} />,
    run: (ctx) => ctx.layout.setOverride("auto"),
  },
  {
    // In a floating window the chat is a column on the right; this shows or hides it. Last in
    // the bar so it sits next to the column it controls.
    id: "chat", label: "Chat", icon: MessageSquare, placement: "bar", keepInBar: true,
    isHidden: (ctx) => !ctx.layout.windowed,
    isActive: (ctx) => ctx.layout.windowChat,
    run: (ctx) => {
      if (ctx.layout.expanded) ctx.layout.setExpanded(false);
      ctx.layout.setWindowChat(!ctx.layout.windowChat);
    },
  },
];

export const visibleItems = (ctx: DesignToolbarContext) => DESIGN_TOOLBAR_ITEMS.filter((i) => !i.isHidden?.(ctx));

export const FRAME_ICONS: Record<DeviceFrameId, ElementType> = {
  desktop: Monitor, tablet: Tablet, phone: Smartphone, slide: Presentation,
};

// shrink-0: a flex item's minimum is its content, so in a narrow pane every button was squeezed
// to its 16px icon and the last ones (Chat among them) were pushed past the edge anyway.
const iconBtn = "flex size-8 shrink-0 items-center justify-center rounded-md text-text-subtle hover:bg-surface-elevated hover:text-foreground disabled:opacity-40";

/** One bar button and the toolbar's `gap-1`. */
const BAR_SLOT_PX = 36;
/** The design title's `mx-2` and the gap before it: the title itself may shrink to nothing. */
const TITLE_MIN_PX = 20;

/**
 * Which bar items get a button when `slots` buttons fit beside the frame picker; the rest are
 * listed in More, ahead of its own items. `keepInBar` items stay, and the More button takes a
 * slot of its own once anything overflows.
 */
export function splitBarItems(bar: DesignToolbarItem[], more: DesignToolbarItem[], slots: number) {
  if (bar.length + (more.length > 0 ? 1 : 0) <= slots) return { shown: bar, overflow: [] as DesignToolbarItem[] };
  const movable = bar.filter((i) => !i.keepInBar);
  const room = Math.max(0, slots - 1 - (bar.length - movable.length));
  const overflow = movable.slice(room);
  return { shown: bar.filter((i) => !overflow.includes(i)), overflow };
}

/** How many bar buttons fit in `row` to the right of `lead` (pane switch, frames, variant). */
function useBarSlots() {
  const rowRef = useRef<HTMLDivElement>(null);
  const leadRef = useRef<HTMLDivElement>(null);
  const [slots, setSlots] = useState(Number.POSITIVE_INFINITY);
  useLayoutEffect(() => {
    const row = rowRef.current;
    const lead = leadRef.current;
    if (!row || !lead) return;
    const measure = () => {
      const style = getComputedStyle(row);
      const inner = row.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      setSlots(Math.max(0, Math.floor((inner - lead.offsetWidth - TITLE_MIN_PX) / BAR_SLOT_PX)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(row);
    ro.observe(lead);
    return () => ro.disconnect();
  }, []);
  return { rowRef, leadRef, slots };
}

/** Desktop toolbar: frame picker on the left, registry items on the right. */
export function DesignToolbar({ ctx }: { ctx: DesignToolbarContext }) {
  const items = visibleItems(ctx);
  const { rowRef, leadRef, slots } = useBarSlots();
  const { shown: bar, overflow } = splitBarItems(
    items.filter((i) => i.placement === "bar"), items.filter((i) => i.placement === "more"), slots,
  );
  const more = [...overflow, ...items.filter((i) => i.placement === "more")];
  return (
    <div ref={rowRef} className="flex min-h-9 shrink-0 items-center gap-1 border-b border-border bg-panel px-2">
      <div ref={leadRef} className="flex shrink-0 items-center gap-1">
        {ctx.layout.switcher === "toolbar" && <DesignPaneSwitch layout={ctx.layout} />}
        <div role="radiogroup" aria-label="Device frame" className="flex items-center gap-0.5">
          {DEVICE_FRAMES.map((f) => {
            const Icon = FRAME_ICONS[f.id];
            const on = ctx.frame === f.id;
            return (
              <button key={f.id} type="button" role="radio" aria-checked={on} title={f.label} aria-label={f.label}
                onClick={() => ctx.setFrame(f.id)}
                className={cn(iconBtn, on && "bg-surface-elevated text-foreground")}>
                <Icon className="size-4" />
              </button>
            );
          })}
        </div>
        <DesignVariantMenu feature={ctx.variants} />
      </div>
      {/* Kept as the spacer but not drawn once buttons overflow: a few leftover pixels of it
          read as a stray glyph, and the window or tab already names the design. */}
      <span className={cn("mx-2 min-w-0 flex-1 truncate text-xs text-text-subtle", overflow.length > 0 && "invisible")}
        title={ctx.design.title}>{ctx.design.title}</span>
      {bar.map((item) => item.renderBar ? item.renderBar(ctx, iconBtn) : (
        <button key={item.id} type="button" title={item.label} aria-label={item.label}
          aria-pressed={item.isActive ? item.isActive(ctx) : undefined}
          disabled={item.isDisabled?.(ctx)} onClick={() => item.run(ctx)}
          className={cn(iconBtn, "relative", item.isActive?.(ctx) && "bg-surface-elevated text-foreground")}>
          <item.icon className="size-4" />
          {/* Inside the button's top edge: the toolbar is only 2px taller than its buttons and a
              window or split clips anything above it, so a badge raised past the edge is cut off. */}
          <ToolbarBadge count={item.badge?.(ctx)} className="absolute -right-1.5 top-0" />
        </button>
      ))}
      {more.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className={iconBtn} aria-label="More canvas actions" title="More">
              <MoreHorizontal className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {more.map((item) => (
              <DropdownMenuItem key={item.id} disabled={item.isDisabled?.(ctx)} onSelect={() => item.run(ctx)}>
                <item.icon className="size-4" /> {item.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
