/**
 * Branch Review — a whole branch's changes as one reviewable list.
 *
 * The surface this exists for: a feature branch with a dozen commits, where
 * opening each commit in turn shows the same file several times in states that
 * were never meant to be read on their own. This shows the end state of every
 * file against where the branch left the base, once.
 *
 * Two things are load-bearing and easy to get wrong:
 *
 * - Every file is opened at `mergeBase`, the commit the server measured the
 *   list against — never at `base` itself. The base branch keeps moving while a
 *   branch is in review, and diffing against its tip renders the base's own
 *   later commits as deletions inside the branch's review.
 * - Paths from the git API are **repository**-relative, and `DiffViewer` takes
 *   **project**-relative ones (it rebases them back itself). A project whose
 *   root is a container of checkouts is where those differ, and handing the
 *   viewer the wrong one shows an empty diff for a file that plainly exists.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api-client";
import { useGitRepo } from "@/hooks/use-git-repo";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { DiffViewer } from "@/components/editor/diff-viewer";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { BottomSheet } from "@/components/ui/mobile-bottom-sheet";
import { GitRepoBar, GitRepoChoice, GitNoRepo } from "@/components/git/git-repo-picker";
import { FileIcon } from "@/lib/file-icons";
import { buildTree, compactTree, type TreeNode } from "@/lib/git-file-tree";
import {
  Check, ChevronDown, ChevronRight, FileText, Loader2, RefreshCw, ListChecks, ArrowRight,
} from "@/lib/icons";
import {
  firstReviewable, isReviewed, loadReviewed, nextUnreviewed, pruneReviewed, reviewKey, reviewedCount,
  saveReviewed, setAllReviewed, toggleReviewed, type ReviewState,
} from "@/lib/branch-review-state";
import type { BranchDiff, BranchDiffFile, GitBranch } from "../../../types/git";

const STATUS_COLORS: Record<BranchDiffFile["status"], string> = {
  M: "text-warning",
  A: "text-success",
  D: "text-error",
  R: "text-primary",
  C: "text-accent-2",
  T: "text-text-3",
};

/** Indent per nesting level, matching the Source Control tree. */
const TREE_INDENT = 14;

/**
 * Ellipsize from the start, so the end of a path — the part that differs —
 * survives. Same trick as the Source Control panel: a right-to-left box cuts at
 * its left edge, and `<bdi>` keeps the name itself reading left to right.
 */
function StartEllipsis({ children }: { children: string }) {
  return (
    <span dir="rtl" className="truncate text-left min-w-0 flex-1">
      <bdi>{children}</bdi>
    </span>
  );
}

/** The base a review defaults to: the branch a feature is normally cut from. */
function defaultBase(branches: GitBranch[], current: string | undefined): string {
  const local = branches.filter((b) => !b.remote && b.name !== current);
  return (
    local.find((b) => b.name === "main")?.name ??
    local.find((b) => b.name === "master")?.name ??
    local[0]?.name ??
    ""
  );
}

interface BranchReviewTabProps {
  metadata?: Record<string, unknown>;
}

export function BranchReviewTab({ metadata }: BranchReviewTabProps) {
  const projectName = metadata?.projectName as string | undefined;
  const gitRepo = useGitRepo(projectName);
  const isMobile = useIsMobile();

  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [base, setBase] = useState("");
  const [head, setHead] = useState("");
  const [diff, setDiff] = useState<BranchDiff | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [reviewed, setReviewed] = useState<ReviewState>({});
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);

  // Branch list → the two pickers, and the defaults a review opens on.
  useEffect(() => {
    if (!projectName || !gitRepo.repo) return;
    let cancelled = false;
    api
      .get<GitBranch[]>(gitRepo.gitUrl("/branches"))
      .then((list) => {
        if (cancelled) return;
        setBranches(list);
        const current = list.find((b) => b.current)?.name;
        setHead((h) => h || current || "");
        setBase((b) => b || defaultBase(list, current));
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Could not list branches"));
    return () => { cancelled = true; };
  }, [projectName, gitRepo]);

  const loadDiff = useCallback(async () => {
    if (!projectName || !gitRepo.repo || !base || !head) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ base, head });
      const result = await api.get<BranchDiff>(gitRepo.gitUrl(`/branch-diff?${params}`));
      setDiff(result);
      setSelectedPath((current) =>
        current && result.files.some((f) => f.path === current)
          ? current
          : firstReviewable(result.files)?.path ?? null,
      );
    } catch (e) {
      setDiff(null);
      setError(e instanceof Error ? e.message : "Could not compare these branches");
    } finally {
      setLoading(false);
    }
  }, [projectName, gitRepo, base, head]);

  useEffect(() => { void loadDiff(); }, [loadDiff]);

  // Review progress is keyed by ref names, so it survives new commits; which
  // files are *still* reviewed is decided per file by the blob id.
  const stateKey = projectName && base && head ? reviewKey(projectName, base, head) : null;
  useEffect(() => {
    setReviewed(stateKey ? loadReviewed(stateKey) : {});
  }, [stateKey]);

  // Prune once the file list arrives: paths a rebase removed would otherwise
  // stay in localStorage forever.
  useEffect(() => {
    if (!stateKey || !diff) return;
    setReviewed((current) => {
      const pruned = pruneReviewed(current, diff.files);
      if (Object.keys(pruned).length !== Object.keys(current).length) saveReviewed(stateKey, pruned);
      return pruned;
    });
  }, [stateKey, diff]);

  const commitReviewed = useCallback((next: ReviewState) => {
    setReviewed(next);
    if (stateKey) saveReviewed(stateKey, next);
  }, [stateKey]);

  const files = diff?.files ?? [];
  const byPath = useMemo(() => new Map(files.map((f) => [f.path, f])), [files]);
  const doneCount = useMemo(() => reviewedCount(reviewed, files), [reviewed, files]);

  // `buildTree` speaks the Source Control panel's shape; only path and status
  // are read from it, and `T` (a mode-only change) has no equivalent there.
  const tree = useMemo(
    () => compactTree(buildTree(files.map((f) => ({
      path: f.path,
      status: f.status === "T" ? "M" : f.status,
    })))),
    [files],
  );

  const selected = selectedPath ? byPath.get(selectedPath) ?? null : null;

  const goToNextUnreviewed = useCallback(() => {
    const next = nextUnreviewed(reviewed, files, selectedPath);
    if (next) {
      setSelectedPath(next.path);
      setListOpen(false);
    }
  }, [reviewed, files, selectedPath]);

  if (gitRepo.noRepo) return <GitNoRepo onReload={gitRepo.reload} />;
  if (gitRepo.needsPick) return <GitRepoChoice repos={gitRepo.repos} onChoose={gitRepo.choose} />;

  const fileList = (
    <ScrollArea className="h-full">
      <div className="py-1">
        {files.length === 0 && !loading && (
          <div className="px-3 py-6 text-center text-xs text-text-3">
            {error ? "—" : "These branches have identical trees."}
          </div>
        )}
        {tree.map((node) => (
          <TreeRow
            key={node.fullPath}
            node={node}
            depth={0}
            byPath={byPath}
            reviewed={reviewed}
            selectedPath={selectedPath}
            collapsed={collapsed}
            onToggleCollapse={(path) => setCollapsed((c) => {
              const next = new Set(c);
              if (next.has(path)) next.delete(path); else next.add(path);
              return next;
            })}
            onSelect={(path) => { setSelectedPath(path); setListOpen(false); }}
            onToggleReviewed={(file) => commitReviewed(toggleReviewed(reviewed, file))}
          />
        ))}
      </div>
    </ScrollArea>
  );

  return (
    <div className="flex flex-col h-full overflow-hidden bg-bg">
      {gitRepo.isNested && gitRepo.repo && (
        <GitRepoBar repo={gitRepo.repo} repos={gitRepo.repos} onChoose={gitRepo.choose} />
      )}

      {/*
        Native selects rather than the shadcn one: a repository can have
        hundreds of branches, and the OS picker is both scrollable and a far
        better touch target than a rendered popover on a phone.
      */}
      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-border shrink-0 flex-wrap">
        <select
          value={base}
          onChange={(e) => setBase(e.target.value)}
          aria-label="Base branch"
          data-testid="branch-review-base"
          className="h-7 max-w-[38%] rounded-md border border-border bg-panel px-2 text-xs min-w-0"
        >
          {branches.map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
        </select>
        <ArrowRight className="size-3.5 text-text-3 shrink-0" />
        <select
          value={head}
          onChange={(e) => setHead(e.target.value)}
          aria-label="Branch to review"
          data-testid="branch-review-head"
          className="h-7 max-w-[38%] rounded-md border border-border bg-panel px-2 text-xs min-w-0"
        >
          {branches.map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
        </select>

        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-text-2 tabular-nums" data-testid="branch-review-progress">
            {doneCount}/{files.length} reviewed
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            title={doneCount === files.length && files.length > 0 ? "Clear all" : "Mark all reviewed"}
            disabled={files.length === 0}
            onClick={() => commitReviewed(setAllReviewed(reviewed, files, doneCount !== files.length))}
          >
            <ListChecks className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon-xs" title="Reload" onClick={() => void loadDiff()}>
            <RefreshCw className={loading ? "animate-spin" : ""} />
          </Button>
        </div>
      </div>

      {error && (
        <div className="px-3 py-1.5 text-xs text-destructive bg-destructive/10 shrink-0">{error}</div>
      )}

      <div className="flex-1 flex min-h-0">
        {!isMobile && (
          <div className="w-72 shrink-0 border-r border-border flex flex-col min-h-0">
            {fileList}
          </div>
        )}

        <div className="flex-1 min-w-0 flex flex-col">
          {selected ? (
            <DiffViewer
              // Remount per file: the viewer keys its fetch off the props it was
              // mounted with, and a shared instance would keep the previous
              // file's contents while the next one loads.
              key={`${selected.path}:${diff?.mergeBase}`}
              metadata={{
                filePath: gitRepo.projectFile(selected.path),
                projectName,
                ref1: diff?.mergeBase,
                ref2: head,
              }}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center text-xs text-text-3">
              {loading ? <Loader2 className="size-4 animate-spin" /> : "Nothing to review."}
            </div>
          )}
        </div>
      </div>

      {/* Thumb zone: on a phone the file list and "next" are the two controls
          used constantly, so they sit at the bottom rather than in the header. */}
      {isMobile && (
        <div className="flex items-center gap-2 border-t border-border p-2 shrink-0">
          <Button variant="secondary" size="sm" className="flex-1 min-h-11" onClick={() => setListOpen(true)}>
            <FileText className="size-4" />
            {files.length} files
          </Button>
          <Button variant="secondary" size="sm" className="flex-1 min-h-11" onClick={goToNextUnreviewed}>
            Next unreviewed
          </Button>
        </div>
      )}

      {isMobile && (
        <BottomSheet open={listOpen} onClose={() => setListOpen(false)}>
          <div className="max-h-[70vh] overflow-hidden flex flex-col">{fileList}</div>
        </BottomSheet>
      )}

      {!isMobile && selected && (
        <div className="flex items-center gap-2 border-t border-border px-2 py-1 shrink-0">
          <StartEllipsis>{selected.path}</StartEllipsis>
          <Button variant="ghost" size="xs" onClick={goToNextUnreviewed}>
            Next unreviewed
          </Button>
        </div>
      )}
    </div>
  );
}

interface TreeRowProps {
  node: TreeNode;
  depth: number;
  byPath: Map<string, BranchDiffFile>;
  reviewed: ReviewState;
  selectedPath: string | null;
  collapsed: Set<string>;
  onToggleCollapse: (path: string) => void;
  onSelect: (path: string) => void;
  onToggleReviewed: (file: BranchDiffFile) => void;
}

function TreeRow(props: TreeRowProps) {
  const { node, depth, byPath, reviewed, selectedPath, collapsed, onToggleCollapse, onSelect, onToggleReviewed } = props;
  const file = node.file ? byPath.get(node.fullPath) : undefined;

  if (!file) {
    const isCollapsed = collapsed.has(node.fullPath);
    return (
      <>
        <button
          type="button"
          className="w-full flex items-center gap-1 px-2 py-1 text-xs min-h-11 md:min-h-0 hover:bg-surface-hover text-left"
          style={{ paddingLeft: depth * TREE_INDENT + 8 }}
          onClick={() => onToggleCollapse(node.fullPath)}
        >
          {isCollapsed ? <ChevronRight className="size-3 shrink-0" /> : <ChevronDown className="size-3 shrink-0" />}
          <span className="truncate text-text-2">{node.name}</span>
        </button>
        {!isCollapsed && node.children.map((child) => (
          <TreeRow key={child.fullPath} {...props} node={child} depth={depth + 1} />
        ))}
      </>
    );
  }

  const done = isReviewed(reviewed, file);
  const isSelected = selectedPath === file.path;
  return (
    <div
      // The selected row may not share `--surface-hover` with the hover state:
      // on a pointer device every row looks selected while the cursor is over
      // it, and which file the diff pane is actually showing becomes a guess.
      // `aria-current` carries the same fact for anything not reading colour.
      className={`flex items-center gap-1.5 pr-2 py-1 text-xs cursor-pointer border-l-2 min-h-11 md:min-h-0 hover:bg-surface-hover ${
        isSelected ? "bg-primary/10 border-primary" : "border-transparent"
      }`}
      style={{ paddingLeft: depth * TREE_INDENT + 6 }}
      onClick={() => onSelect(file.path)}
      aria-current={isSelected ? "true" : undefined}
      data-testid="branch-review-file"
      data-path={file.path}
      data-selected={isSelected ? "true" : "false"}
      data-reviewed={done ? "true" : "false"}
    >
      {/* A real button inside the row, so the tap that reviews a file and the
          tap that opens it never have to be told apart by a timer. */}
      <button
        type="button"
        aria-label={done ? `Mark ${file.path} unreviewed` : `Mark ${file.path} reviewed`}
        data-testid="branch-review-check"
        // The tap area is 44px on touch and the drawn box stays 16px: a
        // checkbox the size of the glyph is the control most often missed, and
        // missing it here selects the file instead — the opposite action.
        className="size-11 md:size-4 shrink-0 flex items-center justify-center"
        onClick={(e) => { e.stopPropagation(); onToggleReviewed(file); }}
      >
        <span
          className={`size-4 rounded border flex items-center justify-center ${
            done ? "bg-primary border-primary text-primary-foreground" : "border-border"
          }`}
        >
          {done && <Check className="size-3" />}
        </span>
      </button>
      <FileIcon name={node.name} className="size-3.5 shrink-0" />
      <StartEllipsis>{node.name}</StartEllipsis>
      <span className={`shrink-0 font-mono ${STATUS_COLORS[file.status]}`}>{file.status}</span>
      {file.binary ? (
        <span className="shrink-0 text-text-3 italic">bin</span>
      ) : (
        <span className="shrink-0 tabular-nums text-[10px]">
          <span className="text-success">+{file.additions}</span>{" "}
          <span className="text-error">-{file.deletions}</span>
        </span>
      )}
    </div>
  );
}
