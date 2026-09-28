import { cn } from "@/lib/utils";
import { DEVICE_FRAMES } from "./canvas/device-frame-presets";
import { FRAME_ICONS, ToolbarBadge, visibleItems, type DesignToolbarContext } from "./design-toolbar";

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
      {visibleItems(ctx).map((item) => (
        <button key={item.id} type="button" className={row} disabled={item.isDisabled?.(ctx)}
          aria-pressed={item.isActive ? item.isActive(ctx) : undefined}
          onClick={() => { onDone(); item.run(ctx); }}>
          <item.icon className="size-5 text-text-subtle" /> <span className="flex-1">{item.label}</span>
          <ToolbarBadge count={item.badge?.(ctx)} />
        </button>
      ))}
    </div>
  );
}
