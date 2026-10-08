/**
 * The parts of a window's identity both skins and the status-bar dock draw the same way: the
 * tinted glyph tile, and the title row (title, dimmer subtitle, "working" marker).
 *
 * Colours come in as a CSS colour expression (a theme token) and are mixed here, so a design
 * window's own colour and a terminal's success green go through one rule.
 */

import type { CSSProperties, ElementType } from "react";
import { cn } from "@/lib/utils";

const TILE_SIZES = {
  sm: "size-4 rounded-[4px] [&_svg]:size-[11px]",
  md: "size-[22px] rounded-md [&_svg]:size-3.5",
  lg: "size-6 rounded-md [&_svg]:size-3.5",
} as const;

export interface WindowTileProps {
  icon: ElementType;
  tone: string;
  size?: keyof typeof TILE_SIZES;
  /** A design's tile is filled with its colour; every other kind gets a tint. */
  filled?: boolean;
  /** Dimmed: the window is minimized. */
  muted?: boolean;
  className?: string;
  children?: React.ReactNode;
}

export function WindowTile({ icon: Icon, tone, size = "md", filled, muted, className, children }: WindowTileProps) {
  const style = {
    "--tone": tone,
    background: filled
      ? "linear-gradient(140deg, var(--tone), color-mix(in srgb, var(--tone) 60%, #000))"
      : "color-mix(in srgb, var(--tone) 20%, transparent)",
    color: filled ? "#fff" : "var(--tone)",
  } as CSSProperties;
  return (
    <span
      aria-hidden="true"
      style={style}
      className={cn(
        "relative grid shrink-0 place-items-center",
        TILE_SIZES[size],
        muted && "opacity-55 saturate-50",
        className,
      )}
    >
      <Icon />
      {children}
    </span>
  );
}

/** The pulsing dot of a window with an AI turn running; sits on a tile's corner. */
export function WindowBusyDot({ className }: { className?: string }) {
  return (
    <span className={cn("absolute -right-[3px] -top-[3px] size-[7px] rounded-full bg-success ring-2 ring-panel", className)}>
      <span className="absolute inset-0 rounded-full bg-success animate-ping motion-reduce:hidden" />
    </span>
  );
}

export interface WindowTitleTextProps {
  title: string;
  subtitle?: string;
  busy: boolean;
  focused: boolean;
  className?: string;
}

/** Title, subtitle and the "Working" marker, in a row that truncates the subtitle first. */
export function WindowTitleText({ title, subtitle, busy, focused, className }: WindowTitleTextProps) {
  return (
    <span className={cn("flex min-w-0 items-center gap-2", className)}>
      <span className={cn("truncate text-[13px] font-semibold", focused ? "text-text" : "text-text-2")}>{title}</span>
      {subtitle && <span className="min-w-0 truncate text-[11px] text-text-3 @max-[560px]/window:hidden">{subtitle}</span>}
      {busy && (
        <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-success">
          <span className="size-1.5 rounded-full bg-current" />
          Working
        </span>
      )}
    </span>
  );
}
