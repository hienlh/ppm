/**
 * VS Code's "Select a branch or tag to checkout" quick pick, opened from the
 * branch name in the status bar.
 *
 * Three things are worth knowing before editing this. The list is `GET /refs`,
 * not `/branches`: the rows carry an author, a hash, a subject and an
 * ahead/behind pair per ref, and tags, none of which `/branches` returns. What
 * a picked row *runs* is `checkoutTarget`, not `git checkout <name>` — see the
 * note there about remote refs detaching HEAD. And it is reachable on desktop
 * only, because the status bar it opens from is `hidden md:flex`; the shell is
 * still written to survive a narrow viewport rather than assume one.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  ArrowDown,
  ArrowUp,
  Check,
  Cloud,
  GitBranch,
  Link2Off,
  Loader2,
  Plus,
  Search,
  Tag,
} from "@/lib/icons";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { useGitRepo } from "@/hooks/use-git-repo";
import { refreshGitStatus } from "@/stores/git-status-store";
import {
  buildRows,
  checkoutTarget,
  firstSelectable,
  localNameFor,
  moveSelection,
  refDetail,
  type PickerAction,
  type PickerRow,
} from "@/lib/git-ref-picker";
import { formatRelativeTime } from "../../../shared/blame";
import type { GitRef } from "../../../types/git";

/**
 * Which question the picker is currently asking.
 *
 * "Create new branch from..." is two questions in VS Code's order — the name
 * first, then the ref — so the pending name rides along on the second stage.
 */
type Stage =
  | { kind: "pick" }
  | { kind: "name"; then: "create" | "from" }
  | { kind: "pick-ref"; purpose: "from" | "detach"; name?: string };

const PLACEHOLDER: Record<Stage["kind"], string> = {
  pick: "Select a branch or tag to checkout",
  name: "Branch name",
  "pick-ref": "Select a ref",
};

function placeholderFor(stage: Stage): string {
  if (stage.kind === "pick-ref") {
    return stage.purpose === "from"
      ? "Select a ref to create the branch from"
      : "Select a branch or tag to checkout in detached mode";
  }
  return PLACEHOLDER[stage.kind];
}

/**
 * The selection tint, and why it is not `bg-accent/15` like the command palette
 * and the extension quick pick beside it.
 *
 * shadcn's `accent` is deliberately a hover **surface** in this app — `globals.css`
 * says so, and maps `--color-accent` to `--panel-2` while the brand blue lives in
 * `--color-primary`. A surface at 15% over the panel it is nearly identical to
 * changes almost nothing: measured in a real browser against the dialog's own
 * background, `bg-accent/15` composites to a contrast ratio of **1.01** on a
 * light panel (rgb(243,247,255) → rgb(245,248,255)) and **1.009** on a dark one,
 * i.e. a keyboard selection nobody can see. `bg-primary/15` carries the brand
 * hue and measures 1.21 on both.
 *
 * Same family as the `opacity`-is-not-dimming note in CLAUDE.md: the class reads
 * perfectly well and paints nothing.
 */
const SELECTED_ROW = "bg-primary/15 text-text-primary";
const HOVER_ROW = "hover:bg-primary/10";

const REF_ICON: Record<GitRef["type"], typeof GitBranch> = {
  branch: GitBranch,
  remote: Cloud,
  tag: Tag,
};

const ACTION_ICON: Record<PickerAction, typeof GitBranch> = {
  create: Plus,
  "create-from": Plus,
  detach: Link2Off,
};

export function BranchPicker({
  projectName,
  onClose,
}: {
  projectName: string;
  onClose: () => void;
}) {
  const { repo, gitUrl, rebaseStatus } = useGitRepo(projectName);
  const [refs, setRefs] = useState<GitRef[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>({ kind: "pick" });
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!repo) return;
    let cancelled = false;
    api
      .get<GitRef[]>(gitUrl("/refs"))
      .then((data) => !cancelled && setRefs(data))
      .catch((e) => !cancelled && setLoadError(e instanceof Error ? e.message : "Could not list refs"));
    return () => {
      cancelled = true;
    };
  }, [repo, gitUrl]);

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const rows = useMemo(
    () => (stage.kind === "name" ? [] : buildRows(refs ?? [], query, { actions: stage.kind === "pick" })),
    [refs, query, stage.kind],
  );

  // A new filter invalidates the old index outright: row 12 of the previous
  // list is a different ref, so clamping it would move the highlight silently.
  useEffect(() => {
    setSelected(firstSelectable(rows));
  }, [rows]);

  useEffect(() => {
    listRef.current?.children[selected]?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const commit = useCallback(
    async (work: () => Promise<unknown>, done: string) => {
      setBusy(true);
      try {
        await work();
      } catch (e) {
        setBusy(false);
        toast.error(e instanceof Error ? e.message : "Git command failed");
        return;
      }
      onClose();
      toast.success(done);
      // The status bar still names the branch just left until this lands.
      void refreshGitStatus(projectName, gitUrl, rebaseStatus);
    },
    [onClose, projectName, gitUrl, rebaseStatus],
  );

  const pickRef = useCallback(
    (ref: GitRef) => {
      if (busy) return;
      if (stage.kind === "pick-ref" && stage.purpose === "detach") {
        void commit(
          () => api.post(gitUrl("/checkout"), { ref: ref.name, mode: "detach" }),
          `Detached HEAD at ${ref.name}`,
        );
        return;
      }
      if (stage.kind === "pick-ref" && stage.name) {
        const name = stage.name;
        void commit(
          () => api.post(gitUrl("/branch/create"), { name, from: ref.name }),
          `Created ${name} from ${ref.name}`,
        );
        return;
      }
      if (ref.current) {
        onClose();
        return;
      }
      const target = checkoutTarget(ref, refs ?? []);
      // `track` lands on the LOCAL branch `-t` creates, not on the remote ref
      // that was picked — naming the remote here would report a branch the user
      // is not on.
      const landedOn = target.mode === "track" ? localNameFor(target.ref) : target.ref;
      void commit(() => api.post(gitUrl("/checkout"), target), `Switched to ${landedOn}`);
    },
    [busy, stage, commit, gitUrl, refs, onClose],
  );

  const pickAction = useCallback((action: PickerAction) => {
    setQuery("");
    setStage(
      action === "detach"
        ? { kind: "pick-ref", purpose: "detach" }
        : { kind: "name", then: action === "create" ? "create" : "from" },
    );
    inputRef.current?.focus();
  }, []);

  const submitName = useCallback(() => {
    const name = query.trim();
    if (!name || stage.kind !== "name" || busy) return;
    if (stage.then === "from") {
      setStage({ kind: "pick-ref", purpose: "from", name });
      setQuery("");
      return;
    }
    void commit(() => api.post(gitUrl("/branch/create"), { name }), `Created ${name}`);
  }, [query, stage, busy, commit, gitUrl]);

  function activate(row: PickerRow | undefined) {
    if (!row) return;
    if (row.kind === "action") pickAction(row.action);
    else if (row.kind === "ref") pickRef(row.ref);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setSelected((i) => moveSelection(rows, i, 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setSelected((i) => moveSelection(rows, i, -1));
        break;
      case "Enter":
        e.preventDefault();
        if (stage.kind === "name") submitName();
        else activate(rows[selected]);
        break;
      case "Escape":
        e.preventDefault();
        // Back out one question at a time, the way a multi-step quick pick does.
        if (stage.kind === "pick") onClose();
        else {
          setStage({ kind: "pick" });
          setQuery("");
        }
        break;
    }
  }

  return (
    /*
     * The desktop panel is bounded by the shell's PADDING, not by a `vh` cap of
     * its own. `pt-[20vh]` beside `max-h-[80vh]` adds up to exactly 100vh, so
     * the panel's bottom edge landed on the viewport's — measured at 620px tall:
     * top 124, bottom 620, gap 0 — and the last row of the list was sliced by
     * the window edge rather than by a visible container, which reads as a
     * dialog overflowing the screen instead of a list that scrolls.
     *
     * `max-h-full` resolves against the flex container's CONTENT box, so the
     * padding below is subtracted for free and the gap survives any window
     * height. Below `md` the panel is a bottom sheet and *should* sit flush on
     * the bottom edge, so the padding is desktop-only.
     */
    <div
      className="fixed inset-0 z-50 flex items-end justify-center md:items-start md:px-4 md:pt-[12vh] md:pb-[10vh]"
      onClick={onClose}
    >
      <div className="fixed inset-0 bg-black/50" />
      <div
        role="dialog"
        aria-label="Checkout a branch or tag"
        className="relative z-10 w-full max-w-xl rounded-t-xl md:rounded-xl border border-border bg-background shadow-2xl overflow-hidden max-h-[80vh] md:max-h-full flex flex-col"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5 shrink-0">
          {busy ? (
            <Loader2 className="size-4 text-text-subtle shrink-0 animate-spin" />
          ) : (
            <Search className="size-4 text-text-subtle shrink-0" />
          )}
          <input
            ref={inputRef}
            type="text"
            value={query}
            disabled={busy}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={placeholderFor(stage)}
            className="flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-subtle disabled:opacity-60"
          />
          <kbd className="hidden sm:inline-flex items-center rounded border border-border bg-surface px-1.5 py-0.5 text-[10px] text-text-subtle font-mono">
            ESC
          </kbd>
        </div>

        {stage.kind === "name" ? (
          <p className="px-3 py-4 text-xs text-text-3">
            {stage.then === "from"
              ? "Press Enter, then choose the ref to branch from."
              : "Press Enter to create the branch from HEAD and switch to it."}
          </p>
        ) : (
          <div ref={listRef} className="overflow-y-auto py-1">
            {loadError ? (
              <p className="px-3 py-4 text-sm text-error text-center">{loadError}</p>
            ) : !refs ? (
              <p className="px-3 py-4 text-sm text-text-subtle text-center">Loading refs…</p>
            ) : rows.length === 0 ? (
              <p className="px-3 py-4 text-sm text-text-subtle text-center">No matching branches or tags</p>
            ) : (
              rows.map((row, i) =>
                row.kind === "separator" ? (
                  <div
                    key={`sep-${row.label}`}
                    className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wide text-text-3 border-t border-border-soft first:border-t-0 first:pt-1"
                  >
                    {row.label}
                  </div>
                ) : row.kind === "action" ? (
                  <Row
                    key={`act-${row.action}`}
                    icon={ACTION_ICON[row.action]}
                    active={i === selected}
                    onSelect={() => pickAction(row.action)}
                    label={row.label}
                  />
                ) : (
                  <RefRow
                    key={row.ref.refName}
                    refItem={row.ref}
                    active={i === selected}
                    onSelect={() => pickRef(row.ref)}
                  />
                ),
              )
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Row({
  icon: Icon,
  label,
  active,
  onSelect,
}: {
  icon: typeof GitBranch;
  label: string;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex items-center gap-2.5 w-full px-3 py-2 text-sm text-left transition-colors",
        active ? SELECTED_ROW : "text-text-secondary " + HOVER_ROW,
      )}
    >
      <Icon className="size-4 shrink-0 text-text-3" />
      <span className="truncate">{label}</span>
    </button>
  );
}

function RefRow({
  refItem,
  active,
  onSelect,
}: {
  refItem: GitRef;
  active: boolean;
  onSelect: () => void;
}) {
  const Icon = refItem.current ? Check : REF_ICON[refItem.type];
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex items-start gap-2.5 w-full px-3 py-1.5 text-sm text-left transition-colors",
        active ? SELECTED_ROW : "text-text-secondary " + HOVER_ROW,
      )}
    >
      <Icon className={cn("size-4 shrink-0 mt-0.5", refItem.current ? "text-primary" : "text-text-3")} />
      <span className="flex-1 min-w-0">
        <span className="flex items-baseline gap-2">
          <span className="truncate">{refItem.name}</span>
          <span className="ml-auto shrink-0 flex items-center gap-1.5 text-xs text-text-3">
            {refItem.behind > 0 && (
              <span className="flex items-center gap-0.5">
                <ArrowDown className="size-3" />
                {refItem.behind}
              </span>
            )}
            {refItem.ahead > 0 && (
              <span className="flex items-center gap-0.5">
                <ArrowUp className="size-3" />
                {refItem.ahead}
              </span>
            )}
            {refItem.gone && <span className="text-warning">gone</span>}
            {/* Without the dot, `↑1 1 hour ago` reads as one number twice. */}
            {(refItem.ahead > 0 || refItem.behind > 0 || refItem.gone) && <span aria-hidden>·</span>}
            <span>{formatRelativeTime(Date.parse(refItem.date))}</span>
          </span>
        </span>
        <span className="block truncate text-xs text-text-3">{refDetail(refItem)}</span>
      </span>
    </button>
  );
}
