/**
 * One row of the branch review tree — a directory or a file.
 *
 * Its own file so it can be *rendered* in a test. Asserting these classes by
 * reading the source back with `readFileSync` passes equally well against a
 * component that never renders at all, and breaks on a `cn()` refactor that
 * changes nothing a user sees; a mounted row survives both.
 *
 * What is pinned here was measured in a real browser at 390x844 before it was:
 * each row came out **24px** tall with a **16px** checkbox, against the 44x44
 * minimum in `docs/design-guidelines.md`. Nothing about that is visible in
 * review — the rows look right on a desktop, which is where the classes were
 * written. Missing the checkbox is worse than missing an ordinary control: the
 * tap falls through to the row and *selects* the file instead of marking it
 * reviewed, which is the opposite action.
 */
import { Check, ChevronDown, ChevronRight } from "@/lib/icons";
import { FileIcon } from "@/lib/file-icons";
import { isReviewed, type ReviewState } from "@/lib/branch-review-state";
import type { TreeNode } from "@/lib/git-file-tree";
import { StartEllipsis } from "@/components/ui/start-ellipsis";
import type { BranchDiffFile } from "../../../types/git";

export const STATUS_COLORS: Record<BranchDiffFile["status"], string> = {
  M: "text-warning",
  A: "text-success",
  D: "text-error",
  R: "text-primary",
  C: "text-accent-2",
  T: "text-text-3",
};

/** Indent per nesting level, matching the Source Control tree. */
export const TREE_INDENT = 14;

export interface TreeRowProps {
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

export function TreeRow(props: TreeRowProps) {
  const { node, depth, byPath, reviewed, selectedPath, collapsed, onToggleCollapse, onSelect, onToggleReviewed } = props;
  const file = node.file ? byPath.get(node.fullPath) : undefined;

  if (!file) {
    const isCollapsed = collapsed.has(node.fullPath);
    return (
      <>
        <button
          type="button"
          data-testid="branch-review-folder"
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
          data-testid="branch-review-check-box"
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
