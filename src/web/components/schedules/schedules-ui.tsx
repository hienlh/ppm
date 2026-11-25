/**
 * The small parts every Schedules view shares: the control sizes (docs/design-guidelines.md rule 3,
 * `control-size.ts`), the permission pill that makes a Bypass schedule stand out, the kind icon and
 * the last-run line.
 */
import type { ElementType } from "react";
import { AlertTriangle, CheckCircle2, Clock, FileCode, Loader2, MessageSquare, XCircle } from "@/lib/icons";
import { PHONE_ICON_CONTROL_SIZE, TEXT_CONTROL_HEIGHT } from "@/lib/control-size";
import { cn } from "@/lib/utils";
import { modeLabel, type RunTone } from "@/lib/schedules/schedules-view";
import type { ScheduleKind } from "../../../types/scheduler";

/** A button with text: 28px tall, 26px below `md`. */
export const TEXT_BUTTON = cn(
  "inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border px-2.5 text-xs text-foreground whitespace-nowrap",
  "hover:bg-surface-hover disabled:opacity-45 disabled:pointer-events-none cursor-pointer [&_svg]:size-3.5",
  TEXT_CONTROL_HEIGHT,
);
export const PRIMARY_BUTTON = cn(TEXT_BUTTON, "border-primary bg-primary text-primary-foreground font-medium hover:bg-primary/90");

/** An icon-only button: 24px square, 22px below `md`. */
export const ICON_BUTTON = cn(
  "inline-flex size-6 shrink-0 items-center justify-center rounded-md text-text-2 hover:bg-surface-hover hover:text-foreground cursor-pointer",
  "disabled:opacity-45 disabled:pointer-events-none [&_svg]:size-[15px]",
  PHONE_ICON_CONTROL_SIZE,
);

/** A filter chip: the text-button height, a count beside its label. */
export const CHIP = cn(
  "inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-2.5 text-xs text-text-2 whitespace-nowrap cursor-pointer",
  "hover:bg-surface-hover aria-pressed:border-accent-wash-border aria-pressed:bg-accent-wash aria-pressed:text-foreground",
  TEXT_CONTROL_HEIGHT,
);

const KIND_ICONS: Record<ScheduleKind, ElementType> = { prompt: MessageSquare, session: Clock, script: FileCode };

export function KindIcon({ kind, className }: { kind: ScheduleKind; className?: string }) {
  const Icon = KIND_ICONS[kind];
  return <Icon aria-hidden className={cn("size-4 shrink-0 text-text-3", className)} />;
}

/** Bypass in warning colours with an icon; any other mode quiet, so Bypass is what the eye finds. */
export function PermissionPill({ mode, className }: { mode: string; className?: string }) {
  const bypass = mode === "bypassPermissions";
  return (
    <span
      data-permission={mode}
      title={bypass ? "Runs every tool without asking, with nobody watching" : `Runs in ${modeLabel(mode)} mode`}
      className={cn(
        "inline-flex h-[18px] shrink-0 items-center gap-1 rounded-[5px] px-1.5 text-[10.5px] font-semibold tracking-wide whitespace-nowrap",
        bypass ? "border border-warning/40 bg-warning/15 text-warning-ink" : "bg-surface-hover text-text-2",
        className,
      )}
    >
      {bypass && <AlertTriangle aria-hidden className="size-3" />}
      {bypass ? "BYPASS" : modeLabel(mode)}
    </span>
  );
}

const TONE_CLASS: Record<RunTone, string> = {
  ok: "text-success", bad: "text-error-ink", warn: "text-warning-ink", running: "text-info", none: "text-text-3",
};
const TONE_ICON: Partial<Record<RunTone, ElementType>> = {
  ok: CheckCircle2, bad: XCircle, warn: Clock, running: Loader2,
};

export function RunStatusLine({ tone, text, when, className }: { tone: RunTone; text: string; when?: string; className?: string }) {
  const Icon = TONE_ICON[tone];
  return (
    <span className={cn("inline-flex min-w-0 max-w-full items-center gap-1 text-[11.5px]", TONE_CLASS[tone], className)}>
      {Icon && <Icon aria-hidden className={cn("size-3.5 shrink-0", tone === "running" && "animate-spin")} />}
      <span className="truncate">{text}</span>
      {when && <span className="shrink-0 text-text-3">· {when}</span>}
    </span>
  );
}

/** The project's colour dot and name. */
export function ProjectTag({ name }: { name: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1 text-[11px] text-text-2">
      <span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ background: projectColor(name) }} />
      <span className="truncate">{name}</span>
    </span>
  );
}

/** A stable colour per project name, from the accent family. */
function projectColor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 70% 62%)`;
}
