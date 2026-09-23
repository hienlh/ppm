import type { ElementType } from "react";
import {
  History, MessageSquarePlus, Monitor, MoreHorizontal, MousePointerClick, Presentation, RefreshCw, Smartphone, Sparkles, Tablet,
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

/**
 * The canvas toolbar and its registry.
 *
 * Features add a button by appending to {@link DESIGN_TOOLBAR_ITEMS}; nothing else in this
 * file needs to change. `bar` items get a button on desktop, `more` items live in the
 * overflow menu. On a phone every item is in the More sheet (the thumb-zone bar only holds
 * Canvas / Chat / More), which renders the same list through {@link DesignToolbarList}.
 */

export interface DesignToolbarContext extends DesignTabContextValue {
  canvas: DesignCanvasState;
  frame: DeviceFrameId;
  setFrame: (frame: DeviceFrameId) => void;
  historyOpen: boolean;
  toggleHistory: () => void;
  comments: DesignCommentsFeature;
}

export interface DesignToolbarItem {
  id: string;
  label: string;
  icon: ElementType;
  placement: "bar" | "more";
  isActive?: (ctx: DesignToolbarContext) => boolean;
  isDisabled?: (ctx: DesignToolbarContext) => boolean;
  /** A count shown on the button, e.g. open comments; nothing when 0 or null. */
  badge?: (ctx: DesignToolbarContext) => number | null;
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
];

function Badge({ count, className }: { count: number | null | undefined; className?: string }) {
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
  const bar = DESIGN_TOOLBAR_ITEMS.filter((i) => i.placement === "bar");
  const more = DESIGN_TOOLBAR_ITEMS.filter((i) => i.placement === "more");
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-panel px-2">
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
      {bar.map((item) => (
        <button key={item.id} type="button" title={item.label} aria-label={item.label}
          aria-pressed={item.isActive ? item.isActive(ctx) : undefined}
          disabled={item.isDisabled?.(ctx)} onClick={() => item.run(ctx)}
          className={cn(iconBtn, "relative", item.isActive?.(ctx) && "bg-surface-elevated text-foreground")}>
          <item.icon className="size-4" />
          <Badge count={item.badge?.(ctx)} className="absolute -right-1 -top-1" />
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

/** The same frames and items as full-width rows, for the phone's More sheet. */
export function DesignToolbarList({ ctx, onDone }: { ctx: DesignToolbarContext; onDone: () => void }) {
  const row = "flex min-h-11 w-full items-center gap-3 rounded-md px-3 text-left text-sm hover:bg-surface-elevated disabled:opacity-40";
  return (
    <div className="flex flex-col gap-1 px-2 pb-2">
      <p className="px-3 pt-1 text-xs font-semibold uppercase tracking-wide text-text-subtle">Device frame</p>
      <div role="radiogroup" aria-label="Device frame" className="grid grid-cols-4 gap-2 px-1">
        {DEVICE_FRAMES.map((f) => {
          const Icon = FRAME_ICONS[f.id];
          const on = ctx.frame === f.id;
          return (
            <button key={f.id} type="button" role="radio" aria-checked={on}
              onClick={() => { ctx.setFrame(f.id); onDone(); }}
              className={cn("flex min-h-14 flex-col items-center justify-center gap-1 rounded-md border text-xs",
                on ? "border-primary text-foreground" : "border-border text-text-subtle")}>
              <Icon className="size-5" /> {f.label}
            </button>
          );
        })}
      </div>
      <div className="my-1 h-px bg-border" />
      {DESIGN_TOOLBAR_ITEMS.map((item) => (
        <button key={item.id} type="button" className={row} disabled={item.isDisabled?.(ctx)}
          aria-pressed={item.isActive ? item.isActive(ctx) : undefined}
          onClick={() => { onDone(); item.run(ctx); }}>
          <item.icon className="size-5 text-text-subtle" /> <span className="flex-1">{item.label}</span>
          <Badge count={item.badge?.(ctx)} />
        </button>
      ))}
    </div>
  );
}
