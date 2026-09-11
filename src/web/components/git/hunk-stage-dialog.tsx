/**
 * Stage, unstage or discard part of a file.
 *
 * The whole-file buttons in the Source Control panel are the common case; this
 * is the escape hatch for a file that holds two unrelated changes. It lists the
 * file's diff and lets each changed line be included or left behind, then sends
 * the chosen hunks to `/git/{stage,unstage,discard}-hunks`, which rebuilds a
 * patch from them server-side.
 *
 * Hunk and line numbers are indexes into the diff *as loaded here*. If the file
 * changes underneath, the server's `git apply` rejects the patch rather than
 * staging the wrong lines, and the error says so.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Loader2, Minus, Plus, Trash2 } from "@/lib/icons";
import { api, projectUrl } from "@/lib/api-client";
import { useGitRepo } from "@/hooks/use-git-repo";
import { basename, cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  allChangedKeys,
  buildHunkRequest,
  hunkState,
  lineKey,
  lineNumbers,
  toggleHunk,
  toggleLine,
  type DiffHunk,
  type LineKey,
} from "./hunk-selection";

export type HunkScope = "worktree" | "index";

interface FileHunks {
  filePath: string;
  scope: HunkScope;
  hunks: DiffHunk[];
  binary: boolean;
}

export interface HunkStageTarget {
  filePath: string;
  scope: HunkScope;
}

interface HunkStageDialogProps {
  projectName: string;
  target: HunkStageTarget | null;
  onClose: () => void;
  /** Called after a successful apply, so the panel can refresh its status. */
  onApplied: () => void;
}

export function HunkStageDialog({ projectName, target, onClose, onApplied }: HunkStageDialogProps) {
  const isMobile = useIsMobile();

  if (!target) return null;

  const body = (
    <HunkStageBody
      projectName={projectName}
      target={target}
      onClose={onClose}
      onApplied={onApplied}
      isMobile={isMobile}
    />
  );

  if (isMobile) {
    return (
      <BottomSheet open onClose={onClose} className="popover-solid max-h-[85dvh] flex flex-col">
        {body}
      </BottomSheet>
    );
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-3xl max-h-[85vh] p-0 gap-0 flex flex-col overflow-hidden"
      >
        <DialogTitle className="sr-only">
          {target.scope === "index" ? "Unstage" : "Stage"} lines in {target.filePath}
        </DialogTitle>
        {body}
      </DialogContent>
    </Dialog>
  );
}

function HunkStageBody({
  projectName,
  target,
  onClose,
  onApplied,
  isMobile,
}: {
  projectName: string;
  target: HunkStageTarget;
  onClose: () => void;
  onApplied: () => void;
  isMobile: boolean;
}) {
  const { gitUrl } = useGitRepo(projectName);
  const { filePath, scope } = target;
  const [data, setData] = useState<FileHunks | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<LineKey>>(new Set());
  const [applying, setApplying] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .get<FileHunks>(
        gitUrl(`/hunks?path=${encodeURIComponent(filePath)}&scope=${scope}`),
      )
      .then((result) => {
        if (cancelled) return;
        setData(result);
        // Everything starts ticked: the common case is still "take it all", and
        // unticking a couple of lines is less work than ticking the rest.
        setSelected(new Set(allChangedKeys(result.hunks)));
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load hunks");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectName, filePath, scope]);

  const hunks = useMemo(() => data?.hunks ?? [], [data]);
  const changedKeys = useMemo(() => allChangedKeys(hunks), [hunks]);
  const request = useMemo(() => buildHunkRequest(hunks, selected), [hunks, selected]);

  const onToggleLine = useCallback((hunk: number, line: number) => {
    setSelected((prev) => toggleLine(hunk, line, prev));
  }, []);

  const onToggleHunk = useCallback(
    (index: number) => setSelected((prev) => toggleHunk(hunks, index, prev)),
    [hunks],
  );

  const onToggleAll = useCallback(
    () => setSelected((prev) => (prev.size === changedKeys.length ? new Set() : new Set(changedKeys))),
    [changedKeys],
  );

  const apply = async (action: "stage" | "unstage" | "discard") => {
    if (request.length === 0) return;
    setApplying(true);
    setError(null);
    try {
      await api.post(gitUrl(`/${action}-hunks`), {
        path: filePath,
        hunks: request,
      });
      onApplied();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : `${action} failed`);
      setApplying(false);
    }
  };

  const primaryLabel = scope === "index" ? "Unstage" : "Stage";
  const PrimaryIcon = scope === "index" ? Minus : Plus;
  const nothingPicked = request.length === 0;

  return (
    <>
      {/* Header. Discard sits up here on purpose: destructive actions belong
          outside the thumb zone, where they are harder to hit by accident. */}
      <div className="shrink-0 px-4 pt-3 pb-2 md:px-5 md:pt-5 border-b border-border">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold truncate">{basename(filePath)}</h2>
            <p className="text-xs text-muted-foreground truncate" title={filePath}>
              {filePath}
            </p>
          </div>
          {scope === "worktree" && (
            <button
              type="button"
              className="flex items-center justify-center size-11 md:size-8 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 active:scale-95 transition-colors disabled:opacity-40"
              onClick={() => setConfirmDiscard(true)}
              disabled={applying || nothingPicked}
              title="Discard selected lines"
            >
              <Trash2 className="size-4" />
            </button>
          )}
        </div>

        {changedKeys.length > 0 && (
          <button
            type="button"
            className="mt-1 flex items-center gap-2 min-h-11 md:min-h-0 md:py-1 text-xs text-muted-foreground active:text-foreground"
            onClick={onToggleAll}
          >
            <CheckBox checked={selected.size === changedKeys.length} partial={selected.size > 0} />
            <span>
              {selected.size} of {changedKeys.length} line{changedKeys.length === 1 ? "" : "s"} selected
            </span>
          </button>
        )}
      </div>

      {/* The diff — the only scrolling region. */}
      <div className="flex-1 min-h-0 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            <span className="text-sm">Loading diff…</span>
          </div>
        ) : data?.binary ? (
          <p className="px-4 py-10 text-sm text-center text-muted-foreground">
            This is a binary file — it can only be staged whole.
          </p>
        ) : hunks.length === 0 ? (
          <p className="px-4 py-10 text-sm text-center text-muted-foreground">
            No {scope === "index" ? "staged" : "unstaged"} changes in this file.
          </p>
        ) : (
          hunks.map((hunk, h) => (
            <HunkBlock
              key={h}
              hunks={hunks}
              hunk={hunk}
              index={h}
              selected={selected}
              onToggleHunk={onToggleHunk}
              onToggleLine={onToggleLine}
              isMobile={isMobile}
            />
          ))
        )}
      </div>

      {error && (
        <div className="shrink-0 px-4 py-2 text-xs text-destructive bg-destructive/10">{error}</div>
      )}

      {/* Footer — the primary action, in the thumb zone. */}
      <div className="shrink-0 flex gap-2 px-4 py-3 md:px-5 border-t border-border">
        {confirmDiscard ? (
          <>
            <Button
              variant="outline"
              className="h-11 md:h-9 px-4"
              onClick={() => setConfirmDiscard(false)}
              disabled={applying}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              className="flex-1 h-11 md:h-9"
              disabled={applying}
              onClick={() => apply("discard")}
            >
              {applying ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                `Discard ${selected.size} line${selected.size === 1 ? "" : "s"} — cannot be undone`
              )}
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" className="h-11 md:h-9 px-4" onClick={onClose} disabled={applying}>
              Cancel
            </Button>
            <Button
              className="flex-1 h-11 md:h-9"
              disabled={applying || nothingPicked}
              onClick={() => apply(scope === "index" ? "unstage" : "stage")}
            >
              {applying ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <>
                  <PrimaryIcon className="size-4" />
                  {primaryLabel} {selected.size} line{selected.size === 1 ? "" : "s"}
                </>
              )}
            </Button>
          </>
        )}
      </div>
    </>
  );
}

function HunkBlock({
  hunks,
  hunk,
  index,
  selected,
  onToggleHunk,
  onToggleLine,
  isMobile,
}: {
  hunks: DiffHunk[];
  hunk: DiffHunk;
  index: number;
  selected: Set<LineKey>;
  onToggleHunk: (index: number) => void;
  onToggleLine: (hunk: number, line: number) => void;
  isMobile: boolean;
}) {
  const { picked, total } = hunkState(hunks, index, selected);
  const numbers = lineNumbers(hunk);

  return (
    <div className="border-b border-border last:border-b-0">
      <button
        type="button"
        className="flex items-center gap-2 w-full min-h-11 md:min-h-0 md:py-1 px-3 text-left bg-muted/40 active:bg-muted transition-colors"
        onClick={() => onToggleHunk(index)}
      >
        <CheckBox checked={picked === total} partial={picked > 0} />
        <span className="text-xs font-mono text-muted-foreground truncate">
          @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
          {hunk.heading ? ` ${hunk.heading}` : ""}
        </span>
      </button>

      {hunk.lines.map((line, i) => {
        const gutter = numbers[i]!;
        if (line.kind === " ") {
          return (
            <div key={i} className="flex items-center font-mono text-xs">
              <LineNumbers old={gutter.old} next={gutter.next} />
              <span className="w-7 shrink-0" />
              <span className="whitespace-pre px-1 py-0.5 text-muted-foreground"> {line.text}</span>
            </div>
          );
        }

        const isOn = selected.has(lineKey(index, i));
        return (
          <button
            key={i}
            type="button"
            className={cn(
              "flex items-center w-full text-left font-mono text-xs transition-colors active:brightness-125",
              isMobile && "min-h-11",
              line.kind === "+" ? "bg-diff-added" : "bg-diff-removed",
              !isOn && "opacity-45",
            )}
            onClick={() => onToggleLine(index, i)}
          >
            <LineNumbers old={gutter.old} next={gutter.next} />
            <span className="flex items-center justify-center w-7 shrink-0">
              <CheckBox checked={isOn} />
            </span>
            <span
              className={cn(
                "whitespace-pre px-1 py-0.5",
                line.kind === "+" ? "text-success" : "text-error",
              )}
            >
              {line.kind}
              {line.text}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** The old/new gutter. Fixed width so every row lines up. */
function LineNumbers({ old, next }: { old: string; next: string }) {
  return (
    <span className="flex shrink-0 select-none text-[10px] text-muted-foreground/70 tabular-nums">
      <span className="w-10 text-right pr-1">{old}</span>
      <span className="w-10 text-right pr-1">{next}</span>
    </span>
  );
}

/**
 * A checkbox drawn rather than an `<input>`: each one sits inside a button that
 * owns the tap, and a nested input would fight it for the event.
 */
function CheckBox({ checked, partial }: { checked: boolean; partial?: boolean }) {
  return (
    <span
      className={cn(
        "flex items-center justify-center size-4 shrink-0 rounded border transition-colors",
        checked
          ? "bg-primary border-primary text-primary-foreground"
          : partial
            ? "border-primary"
            : "border-border",
      )}
    >
      {checked ? (
        <Check className="size-3" strokeWidth={3} />
      ) : partial ? (
        <span className="size-2 rounded-[1px] bg-primary" />
      ) : null}
    </span>
  );
}
