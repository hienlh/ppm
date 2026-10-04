/**
 * The stashes, folded away under the change list: apply one with a click,
 * pop or drop it from its menu.
 */
import { useEffect, useRef, useState } from "react";
import { Archive, ChevronRight } from "@/lib/icons";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { formatRelativeDate } from "@/lib/format-date";
import { useGitRepo } from "@/hooks/use-git-repo";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/adaptive-context-menu";
import type { StashEntry } from "../../../shared/git-changes";
import { CountChip } from "./git-change-parts";

export type StashAction = "apply" | "pop" | "drop";

export function GitStashSection({ projectName, count, busy, onAction }: {
  projectName: string;
  /** From the changes answer; a change in it re-reads the list. */
  count: number;
  busy: string | null;
  onAction: (action: StashAction, stash: StashEntry, anchor: HTMLElement) => void;
}) {
  const { gitUrl } = useGitRepo(projectName);
  const [expanded, setExpanded] = useState(false);
  const [stashes, setStashes] = useState<StashEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    api.get<StashEntry[]>(gitUrl("/stashes"))
      .then((list) => { if (!cancelled) { setStashes(list); setError(null); } })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "Could not list stashes"); });
    return () => { cancelled = true; };
  }, [expanded, count, gitUrl]);

  if (count === 0) return null;
  return (
    <div>
      <FoldHeader label="Stashes" count={count} expanded={expanded} onToggle={() => setExpanded(!expanded)} />
      {expanded && (
        <div className="pb-2 pl-2.5 pr-1.5">
          {error && <p className="px-1 py-1 text-xs text-error">{error}</p>}
          {stashes?.map((stash) => (
            <StashRow key={stash.hash} stash={stash} busy={busy} onAction={onAction} />
          ))}
        </div>
      )}
    </div>
  );
}

function StashRow({ stash, busy, onAction }: {
  stash: StashEntry;
  busy: string | null;
  onAction: (action: StashAction, stash: StashEntry, anchor: HTMLElement) => void;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const act = (action: StashAction, anchor: HTMLElement | null) => {
    if (anchor) onAction(action, stash, anchor);
  };
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={rowRef}
          className="flex min-h-12 md:min-h-[34px] items-center gap-2 rounded-md px-1 py-0.5 text-[12.5px] select-none can-hover:hover:bg-surface-hover"
        >
          <Archive className="size-3.5 shrink-0 text-text-3" />
          <span className="flex min-w-0 flex-1 flex-col leading-[1.3]">
            <b className="truncate font-medium">{stash.message || "(no message)"}</b>
            <small className="truncate text-[11px] text-text-3">
              stash@{"{"}{stash.index}{"}"}
              {stash.branch ? ` · ${stash.branch}` : ""}
              {stash.date ? ` · ${formatRelativeDate(stash.date)}` : ""}
            </small>
          </span>
          <Button
            variant="ghost"
            size="xs"
            className="max-md:h-10"
            disabled={!!busy}
            onClick={(e) => act("apply", e.currentTarget)}
          >
            Apply
          </Button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-40">
        <ContextMenuItem onClick={() => act("apply", rowRef.current)} disabled={!!busy}>Apply</ContextMenuItem>
        <ContextMenuItem onClick={() => act("pop", rowRef.current)} disabled={!!busy}>Pop</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onClick={() => act("drop", rowRef.current)} disabled={!!busy}>
          Drop…
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** The heading of a folded section at the foot of the panel. */
export function FoldHeader({ label, count, expanded, onToggle }: {
  label: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      onClick={onToggle}
      className="flex h-11 md:h-8 w-full items-center gap-1.5 px-2.5 text-left text-[10.5px] font-semibold uppercase tracking-[.07em] text-text-3 hover:text-text-2"
    >
      <ChevronRight className={cn("size-3.5 transition-transform", expanded && "rotate-90")} />
      {label}
      <CountChip count={count} />
    </button>
  );
}
