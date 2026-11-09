/**
 * The usage figures of the chat footer: a ring per window beside the ··· button and the thin meters in the
 * menu and on each account card. Colour is spent only where it says something — below 70% the
 * ring is green and its number stays quiet, from 70% it turns amber and from 90% red.
 * Both the ring and the bars animate to a new value, and stop animating under reduced motion.
 */
import { cn } from "@/lib/utils";
import { usageTone } from "@/lib/chat-account-switch";

const RING_LENGTH = 31.4; // 2π · r=5

const STROKE = { ok: "stroke-success", warn: "stroke-warning", error: "stroke-error" } as const;
const FILL = { ok: "bg-success", warn: "bg-warning", error: "bg-error" } as const;
const TEXT = { ok: "text-text-2", warn: "text-warning", error: "text-error" } as const;

export function UsageRing({ pct, className }: { pct: number | null; className?: string }) {
  const tone = usageTone(pct);
  const filled = (RING_LENGTH * Math.min(100, Math.max(0, pct ?? 0))) / 100;
  return (
    <svg viewBox="0 0 14 14" aria-hidden="true" className={cn("size-3.5 shrink-0 -rotate-90", className)}>
      <circle cx="7" cy="7" r="5" fill="none" strokeWidth="2" className="stroke-border" />
      <circle
        cx="7" cy="7" r="5" fill="none" strokeWidth="2" strokeLinecap="round"
        strokeDasharray={`${filled.toFixed(1)} ${RING_LENGTH}`}
        className={cn(STROKE[tone], "transition-[stroke-dasharray] duration-300 ease-out motion-reduce:transition-none", pct == null && "opacity-0")}
      />
    </svg>
  );
}

/** The number beside the ring: quiet until it is worth reading. */
export function usagePctClass(pct: number | null): string {
  return TEXT[usageTone(pct)];
}

/**
 * One window in the footer: "◔ 5h 47%". Each colours on its own, and a window with no figure is
 * not drawn at all. A narrow chat drops the ring and keeps the label, which is what tells the two
 * apart (and from the context window's own usage).
 */
export function UsageWindow({ label, pct }: { label: string; pct: number | null }) {
  if (pct == null) return null;
  return (
    <span className="inline-flex items-center gap-1" data-usage-window={label}>
      <UsageRing pct={pct} className="!size-3 @max-[420px]/chat:hidden max-md:hidden" />
      <span className="text-text-3">{label}</span>
      <span className={cn("font-medium tabular-nums", usagePctClass(pct))}>{pct}%</span>
    </span>
  );
}

/** A thin bar; at 100% it reads red whatever the band, as a full window does. */
export function UsageTrack({ pct, className }: { pct: number | null; className?: string }) {
  const value = Math.min(100, Math.max(0, pct ?? 0));
  return (
    <span className={cn("block h-1 overflow-hidden rounded-sm bg-surface-hover", className)}>
      <i
        className={cn("block h-full rounded-sm transition-[width] duration-300 ease-out motion-reduce:transition-none", FILL[usageTone(pct)])}
        style={{ width: `${value}%` }}
      />
    </span>
  );
}

/** One labelled meter row: "5 hours ▬▬▬── 47%". */
export function UsageMeter({ label, pct }: { label: string; pct: number | null }) {
  return (
    <div className="mt-1.5 flex items-center gap-2 text-[11px] text-text-2">
      <span className="w-[52px] shrink-0">{label}</span>
      <UsageTrack pct={pct} className="flex-1" />
      <span className="w-9 shrink-0 text-right tabular-nums">{pct != null ? `${pct}%` : "--%"}</span>
    </div>
  );
}
