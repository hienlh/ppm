import {
  GitBranch,
  GitMerge,
  Trash2,
  ArrowUpFromLine,
  ExternalLink,
  Tag,
} from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { GitBranch as GitBranchType } from "../../../types/git";

interface BranchLabelProps {
  name: string;
  type: "branch" | "tag";
  remotes: string[];
  isCurrent: boolean;
  color: string;
  currentBranch: GitBranchType | undefined;
  onCheckout: (ref: string) => void;
  onMerge: (source: string) => void;
  onPush: (branch: string) => void;
  onCreatePr: (branch: string) => void;
  onDelete: (name: string) => void;
}

export function BranchLabel({
  name,
  type,
  remotes,
  isCurrent,
  color,
  currentBranch,
  onCheckout,
  onMerge,
  onPush,
  onCreatePr,
  onDelete,
}: BranchLabelProps) {
  if (type === "tag") {
    return (
      <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 bg-amber-500/20 text-amber-500 border border-amber-500/30">
        <Tag className="size-2.5" />
        {name}
      </span>
    );
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <span
          className="inline-flex items-center rounded text-[10px] font-medium shrink-0 cursor-context-menu overflow-hidden"
          style={{
            border: isCurrent
              ? `1.5px solid ${color}`
              : `1px solid ${color}50`,
          }}
        >
          {/* Branch name segment */}
          <span
            className="inline-flex items-center gap-0.5 px-1.5 py-0.5"
            style={{
              backgroundColor: isCurrent ? color : `${color}30`,
              color: isCurrent ? "#fff" : color,
            }}
          >
            <GitBranch className="size-2.5" />
            {name}
          </span>
          {/* Remote indicators (italic, separated by border) */}
          {remotes.map((remote) => (
            <span
              key={remote}
              className="px-1.5 py-0.5 italic opacity-70"
              style={{
                borderLeft: `1px solid ${color}40`,
                color,
                backgroundColor: `${color}15`,
              }}
            >
              {remote}
            </span>
          ))}
        </span>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={() => onCheckout(name)}>
          Checkout
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() => onMerge(name)}
          disabled={name === currentBranch?.name}
        >
          <GitMerge className="size-3" />
          Merge into current
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => onPush(name)}>
          <ArrowUpFromLine className="size-3" />
          Push
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onCreatePr(name)}>
          <ExternalLink className="size-3" />
          Create PR
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          variant="destructive"
          onClick={() => onDelete(name)}
          disabled={name === currentBranch?.name}
        >
          <Trash2 className="size-3" />
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
