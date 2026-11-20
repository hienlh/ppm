/**
 * The path on a phone, as a row of chips — one per folder from the root (or `~`) down to the
 * folder on screen — that scrolls sideways and starts scrolled to its end, where the folder on
 * screen is. Tapping a chip goes to that folder.
 *
 * The segments are the server's (`FsBreadcrumb`), as on desktop: a drive root, a UNC prefix and
 * a POSIX root all split differently, and the client never splits a host path itself.
 */

import { useLayoutEffect, useRef } from "react";
import { ChevronRight } from "@/lib/icons";
import type { FsBreadcrumb } from "@/lib/fs-api";
import { cn } from "@/lib/utils";
import { MOBILE_EXPLORER_CHIP } from "./mobile-explorer-chip";

export interface MobilePathBreadcrumbProps {
  crumbs: FsBreadcrumb[];
  onNavigate(path: string): void;
}

export function MobilePathBreadcrumb({ crumbs, onNavigate }: MobilePathBreadcrumbProps) {
  const rowRef = useRef<HTMLElement>(null);
  const last = crumbs[crumbs.length - 1]?.path;
  // Each new folder brings the end of the path into view: that is the part that changed.
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (row) row.scrollLeft = row.scrollWidth;
  }, [last]);

  if (crumbs.length === 0) return null;
  return (
    <nav
      ref={rowRef}
      aria-label="Path"
      data-testid="explorer-mobile-breadcrumb"
      className="flex items-center gap-0.5 overflow-x-auto touch-pan-x px-2 pb-1.5 [scrollbar-width:none]"
    >
      {crumbs.map((crumb, index) => {
        const current = index === crumbs.length - 1;
        return (
          <span key={crumb.path} className="flex shrink-0 items-center gap-0.5">
            {index > 0 && <ChevronRight className="size-3 shrink-0 text-text-subtle" />}
            <button
              type="button"
              title={crumb.path}
              aria-current={current ? "location" : undefined}
              onClick={() => onNavigate(crumb.path)}
              className={cn(
                MOBILE_EXPLORER_CHIP,
                current ? "border-primary bg-accent-wash font-medium text-text" : "border-border text-text-2",
              )}
            >
              <span className="max-w-[10rem] truncate">{crumb.name}</span>
            </button>
          </span>
        );
      })}
    </nav>
  );
}
