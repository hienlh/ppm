/**
 * Path breadcrumb built from the server's segments — the client never splits paths itself,
 * because a drive root, a UNC prefix and a POSIX root all split differently.
 *
 * Deep paths keep the first crumb and the last few; everything in between collapses into
 * one overflow menu, so the bar never pushes the toolbar controls out of a narrow window.
 */

import { ChevronRight, MoreHorizontal } from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { FsBreadcrumb } from "@/lib/fs-api";
import { cn } from "@/lib/utils";
import { DROP_TARGET_CLASS } from "./dnd/drop-target-style";
import { usePathDropTarget } from "./dnd/use-path-drop-target";
import { useDropTransfer } from "./dnd/use-drop-transfer";

/** Crumbs shown at the tail before the middle is collapsed. */
const TAIL_CRUMBS = 3;

export interface ExplorerBreadcrumbProps {
  crumbs: FsBreadcrumb[];
  onNavigate(path: string): void;
  className?: string;
  /** Host path separator — every crumb is an ancestor directory of the same window. */
  sep: string;
}

export function ExplorerBreadcrumb({ crumbs, onNavigate, className, sep }: ExplorerBreadcrumbProps) {
  // One drop-transfer context for the whole bar — dropping on any ancestor crumb lands
  // through the same collision prompt as a paste.
  const { run, prompts } = useDropTransfer(sep);

  if (crumbs.length === 0) return <div className={className} />;

  const collapsed = crumbs.length > TAIL_CRUMBS + 2;
  const head = collapsed ? crumbs.slice(0, 1) : crumbs;
  const hidden = collapsed ? crumbs.slice(1, crumbs.length - TAIL_CRUMBS) : [];
  const tail = collapsed ? crumbs.slice(crumbs.length - TAIL_CRUMBS) : [];

  return (
    <nav aria-label="Path" className={cn("flex min-w-0 items-center gap-0.5 text-xs", className)}>
      {head.map((crumb) => (
        <span key={crumb.path} className="flex shrink-0 items-center gap-0.5">
          <BreadcrumbCrumb crumb={crumb} last={!collapsed && crumb === crumbs[crumbs.length - 1]} onNavigate={onNavigate} run={run} />
          <ChevronRight className="size-3 shrink-0 text-text-subtle" />
        </span>
      ))}

      {collapsed && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Show hidden path segments"
              className="rounded px-1 py-0.5 text-text-2 can-hover:hover:bg-surface-elevated"
            >
              <MoreHorizontal className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
            {hidden.map((crumb) => (
              <DropdownMenuItem key={crumb.path} onClick={() => onNavigate(crumb.path)}>
                {crumb.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {collapsed && <ChevronRight className="size-3 shrink-0 text-text-subtle" />}

      {tail.map((crumb, index) => (
        <span key={crumb.path} className="flex min-w-0 items-center gap-0.5">
          <BreadcrumbCrumb crumb={crumb} last={index === tail.length - 1} onNavigate={onNavigate} run={run} />
          {index < tail.length - 1 && <ChevronRight className="size-3 shrink-0 text-text-subtle" />}
        </span>
      ))}
      {prompts}
    </nav>
  );
}

interface BreadcrumbCrumbProps {
  crumb: FsBreadcrumb;
  last: boolean;
  onNavigate(path: string): void;
  run: ReturnType<typeof useDropTransfer>["run"];
}

/** One crumb, as its own component: a drop target needs its own hook call per crumb. */
function BreadcrumbCrumb({ crumb, last, onNavigate, run }: BreadcrumbCrumbProps) {
  const drop = usePathDropTarget({ targetDir: crumb.path, run });
  return (
    <button
      type="button"
      onClick={() => onNavigate(crumb.path)}
      className={cn(
        "max-w-[12rem] truncate rounded px-1 py-0.5 can-hover:hover:bg-surface-elevated",
        last ? "font-medium text-text" : "text-text-2",
        drop.isOver && DROP_TARGET_CLASS,
      )}
      {...drop.handlers}
    >
      {crumb.name}
    </button>
  );
}
