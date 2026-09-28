import type { ElementType, ReactNode } from "react";
import {
  Code, Columns2, Download, History, Maximize2, MessageSquarePlus, Monitor, MoreHorizontal, MousePointerClick, Move,
  Presentation, RefreshCw, SlidersHorizontal, Smartphone, Sparkles, Tablet, Undo2,
} from "@/lib/icons";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { deliverToDesignChat } from "@/lib/design/deliver-to-design-chat";
import { buildDesignSystemInitPrompt } from "../../../shared/design-system-init-prompt";
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
    // Fills the composer and waits: the user reviews the brief and sends it themselves.
    id: "design-system", label: "Set up design system", icon: Sparkles, placement: "more",
    run: (ctx) => deliverToDesignChat(ctx.tabId, buildDesignSystemInitPrompt(), "Set up design system"),
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
    // Starts a new, ordinary chat with the brief as a draft; never the design chat.
    id: "handoff", label: "Hand off to code", icon: Code, placement: "more",
    run: (ctx) => ctx.exports.handOff(),
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
    id: "layout", label: "Layout", icon: Columns2, placement: "bar",
    isHidden: (ctx) => ctx.isMobile || ctx.layout.expanded,
    renderBar: (ctx, className) => <DesignLayoutMenu key="layout" layout={ctx.layout} className={className} />,
    run: (ctx) => ctx.layout.setOverride("auto"),
  },
];

export const visibleItems = (ctx: DesignToolbarContext) => DESIGN_TOOLBAR_ITEMS.filter((i) => !i.isHidden?.(ctx));

export function ToolbarBadge({ count, className }: { count: number | null | undefined; className?: string }) {
  if (!count) return null;
  return (
    <span className={cn("flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-primary-foreground", className)}>
      {count > 99 ? "99+" : count}
    </span>
  );
}

export const FRAME_ICONS: Record<DeviceFrameId, ElementType> = {
  desktop: Monitor, tablet: Tablet, phone: Smartphone, slide: Presentation,
};

const iconBtn = "flex size-8 items-center justify-center rounded-md text-text-subtle hover:bg-surface-elevated hover:text-foreground disabled:opacity-40";

/** Desktop toolbar: frame picker on the left, registry items on the right. */
export function DesignToolbar({ ctx }: { ctx: DesignToolbarContext }) {
  const items = visibleItems(ctx);
  const bar = items.filter((i) => i.placement === "bar");
  const more = items.filter((i) => i.placement === "more");
  return (
    <div className="flex min-h-9 shrink-0 items-center gap-1 border-b border-border bg-panel px-2">
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
      <span className="mx-2 min-w-0 flex-1 truncate text-xs text-text-subtle" title={ctx.design.title}>{ctx.design.title}</span>
      {bar.map((item) => item.renderBar ? item.renderBar(ctx, iconBtn) : (
        <button key={item.id} type="button" title={item.label} aria-label={item.label}
          aria-pressed={item.isActive ? item.isActive(ctx) : undefined}
          disabled={item.isDisabled?.(ctx)} onClick={() => item.run(ctx)}
          className={cn(iconBtn, "relative", item.isActive?.(ctx) && "bg-surface-elevated text-foreground")}>
          <item.icon className="size-4" />
          <ToolbarBadge count={item.badge?.(ctx)} className="absolute -right-1 -top-1" />
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
