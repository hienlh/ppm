import { useState } from "react";
import { AlertTriangle, X } from "@/lib/icons";
import { cn } from "@/lib/utils";

/**
 * What went wrong in the design document on screen: script errors, failed loads, CSP
 * blocks, links the canvas refused to follow, and layout problems the self-check found
 * after the last turn. Everything here was reported by the page, so it is untrusted and
 * rendered as plain text only.
 */

export type CanvasIssue =
  | { kind: "error" | "rejection" | "resource" | "csp"; message: string; source?: string; line?: number }
  | { kind: "navigate-blocked"; message: string; source: string }
  /** Found by the canvas self-check after a turn; `source` names the element. */
  | { kind: "layout"; message: string; source?: string };

const KIND_LABEL: Record<CanvasIssue["kind"], string> = {
  error: "Error",
  rejection: "Unhandled rejection",
  resource: "Failed to load",
  csp: "Blocked by policy",
  "navigate-blocked": "Link blocked",
  layout: "Layout",
};

/** Kept per document load; the bridge itself stops at 20, and so does this list. */
export const MAX_CANVAS_ISSUES = 20;

export function DesignIssuesBadge({ issues, className }: { issues: CanvasIssue[]; className?: string }) {
  const [open, setOpen] = useState(false);
  if (issues.length === 0) return null;
  return (
    <div className={cn("pointer-events-auto", className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`${issues.length} canvas ${issues.length === 1 ? "issue" : "issues"}`}
        className="flex min-h-11 items-center gap-1.5 rounded-full border border-warning/40 bg-panel px-3 text-xs font-medium text-warning shadow-md md:min-h-8"
      >
        <AlertTriangle className="size-4" />
        {issues.length}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-10 mt-1 w-[min(22rem,calc(100vw-2rem))] rounded-lg border border-border bg-popover text-popover-foreground shadow-lg">
          <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
            <span className="text-xs font-semibold">Canvas issues</span>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close"
              className="flex size-11 items-center justify-center rounded-md text-text-subtle hover:bg-surface-elevated md:size-7">
              <X className="size-4" />
            </button>
          </div>
          <ul className="max-h-72 overflow-y-auto p-2 text-xs">
            {issues.map((issue, i) => (
              <li key={i} className="border-b border-border/50 py-1.5 last:border-0">
                <span className="font-medium text-warning">{KIND_LABEL[issue.kind]}</span>{" "}
                <span className="break-words">{issue.message}</span>
                {issue.source && (
                  <span className="block truncate text-text-subtle" title={issue.source}>
                    {issue.source}{"line" in issue && issue.line ? `:${issue.line}` : ""}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
