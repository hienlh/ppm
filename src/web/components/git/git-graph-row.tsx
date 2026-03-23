import {
  GitBranch as GitBranchIcon,
  Tag,
  Copy,
  RotateCcw,
  CherryIcon,
} from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { BranchLabel } from "./git-graph-branch-label";
import { LANE_COLORS, ROW_HEIGHT, relativeDate } from "./git-graph-constants";
import type { GitCommit, GitBranch } from "../../../types/git";

interface CommitLabel {
  name: string;
  type: "branch" | "tag";
  remotes: string[];
  current: boolean;
}

interface GitGraphRowProps {
  commit: GitCommit;
  lane: number;
  isSelected: boolean;
  isHead: boolean;
  labels: CommitLabel[];
  currentBranch: GitBranch | undefined;
  onSelect: () => void;
  onCheckout: (ref: string) => void;
  onCherryPick: (hash: string) => void;
  onRevert: (hash: string) => void;
  onMerge: (source: string) => void;
  onDeleteBranch: (name: string) => void;
  onPushBranch: (branch: string) => void;
  onCreatePr: (branch: string) => void;
  onOpenCreateBranch: (hash: string) => void;
  onOpenCreateTag: (hash: string) => void;
  onOpenDiff: () => void;
  onCopyHash: () => void;
}

export function GitGraphRow({
  commit,
  lane,
  isSelected,
  isHead,
  labels,
  currentBranch,
  onSelect,
  onCheckout,
  onCherryPick,
  onRevert,
  onMerge,
  onDeleteBranch,
  onPushBranch,
  onCreatePr,
  onOpenCreateBranch,
  onOpenCreateTag,
  onOpenDiff,
  onCopyHash,
}: GitGraphRowProps) {
  const color = LANE_COLORS[lane % LANE_COLORS.length]!;
  const branchLabels = labels.filter((l) => l.type === "branch");
  const tagLabels = labels.filter((l) => l.type === "tag");

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <tr
          className={`hover:bg-muted/50 cursor-pointer border-b border-border/20 ${
            isSelected ? "bg-primary/10" : ""
          } ${isHead ? "font-medium" : ""}`}
          style={{ height: `${ROW_HEIGHT}px` }}
          onClick={onSelect}
        >
          {/* Description column */}
          <td className="px-2 truncate max-w-0">
            <div className="flex items-center gap-1.5 min-w-0">
              {branchLabels.map((label) => (
                <BranchLabel
                  key={`branch-${label.name}`}
                  name={label.name}
                  type="branch"
                  remotes={label.remotes}
                  isCurrent={label.current}
                  color={color}
                  currentBranch={currentBranch}
                  onCheckout={onCheckout}
                  onMerge={onMerge}
                  onPush={onPushBranch}
                  onCreatePr={onCreatePr}
                  onDelete={onDeleteBranch}
                />
              ))}
              {tagLabels.map((label) => (
                <BranchLabel
                  key={`tag-${label.name}`}
                  name={label.name}
                  type="tag"
                  remotes={[]}
                  isCurrent={false}
                  color={color}
                  currentBranch={currentBranch}
                  onCheckout={onCheckout}
                  onMerge={onMerge}
                  onPush={onPushBranch}
                  onCreatePr={onCreatePr}
                  onDelete={onDeleteBranch}
                />
              ))}
              <span className="truncate text-xs">{commit.subject}</span>
            </div>
          </td>

          {/* Date column */}
          <td className="px-2 text-xs text-muted-foreground whitespace-nowrap shrink-0">
            {relativeDate(commit.authorDate)}
          </td>

          {/* Author column */}
          <td className="px-2 text-xs text-muted-foreground truncate max-w-[120px]">
            {commit.authorName}
          </td>

          {/* Commit hash column (last) */}
          <td className="px-2 text-xs text-muted-foreground font-mono whitespace-nowrap">
            {commit.abbreviatedHash}
          </td>
        </tr>
      </ContextMenuTrigger>

      <ContextMenuContent>
        <ContextMenuItem onClick={() => onCheckout(commit.hash)}>
          Checkout
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onOpenCreateBranch(commit.hash)}>
          <GitBranchIcon className="size-3" />
          Create Branch...
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => onCherryPick(commit.hash)}>
          <CherryIcon className="size-3" />
          Cherry Pick
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onRevert(commit.hash)}>
          <RotateCcw className="size-3" />
          Revert
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onOpenCreateTag(commit.hash)}>
          <Tag className="size-3" />
          Create Tag...
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={onOpenDiff}>View Diff</ContextMenuItem>
        <ContextMenuItem onClick={onCopyHash}>
          <Copy className="size-3" />
          Copy Hash
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
