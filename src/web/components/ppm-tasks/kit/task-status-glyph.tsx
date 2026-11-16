/**
 * A task's status as a small glyph drawn by its base group: an empty ring (not started), a half
 * fill (active), a dashed ring (waiting), a filled dot (done) or a struck ring (dropped). With
 * `showName`, the status name follows the glyph.
 */
import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import type { BaseGroup, ClosedAs } from "../../../../shared/ppm-tasks";

export type StatusGlyphKind = "todo" | "active" | "wait" | "done" | "drop";

export function statusGlyphKind(baseGroup: BaseGroup, closedAs: ClosedAs | null): StatusGlyphKind {
  if (baseGroup === "closed") return closedAs === "dropped" ? "drop" : "done";
  return baseGroup === "active" ? "active" : baseGroup === "waiting" ? "wait" : "todo";
}

const GLYPH: Record<StatusGlyphKind, CSSProperties> = {
  todo: { border: "1.5px solid var(--text-3)" },
  active: { border: "1.5px solid var(--accent)", background: "conic-gradient(var(--accent) 0 50%, transparent 50% 100%)" },
  wait: { border: "1.5px dashed var(--warning)" },
  done: { border: "1.5px solid var(--success)", background: "var(--success)", boxShadow: "inset 0 0 0 2.5px var(--panel)" },
  drop: { border: "1.5px solid var(--text-3)", background: "linear-gradient(45deg, transparent 44%, var(--text-3) 44% 56%, transparent 56%)" },
};

export interface TaskStatusGlyphProps {
  baseGroup: BaseGroup;
  closedAs: ClosedAs | null;
  /** The status name: shown after the glyph with `showName`, else its label. */
  name?: string;
  showName?: boolean;
  size?: "md" | "lg";
  className?: string;
}

export function TaskStatusGlyph({ baseGroup, closedAs, name, showName = false, size = "md", className }: TaskStatusGlyphProps) {
  const kind = statusGlyphKind(baseGroup, closedAs);
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-text-2", className)} data-status-glyph={kind}
      title={showName ? undefined : name} aria-label={showName ? undefined : name}>
      <span aria-hidden className={cn("box-border shrink-0 rounded-full", size === "lg" ? "size-4" : "size-3")} style={GLYPH[kind]} />
      {showName && name ? <span className="truncate">{name}</span> : null}
    </span>
  );
}
