import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "../ui/context-menu.tsx";
import type { GitCommit } from "../../../types/git.ts";

interface Props {
  commit: GitCommit;
  children: React.ReactNode;
  onCheckout: (hash: string) => void;
  onCreateBranch: (hash: string) => void;
  onCherryPick: (hash: string) => void;
  onRevert: (hash: string) => void;
  onCreateTag: (hash: string) => void;
  onCopyHash: (hash: string) => void;
  onViewDiff: (hash: string) => void;
}

export function CommitContextMenu({
  commit,
  children,
  onCheckout,
  onCreateBranch,
  onCherryPick,
  onRevert,
  onCreateTag,
  onCopyHash,
  onViewDiff,
}: Props) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem onClick={() => onCheckout(commit.hash)}>Checkout</ContextMenuItem>
        <ContextMenuItem onClick={() => onCreateBranch(commit.hash)}>Create Branch</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => onCherryPick(commit.hash)}>Cherry Pick</ContextMenuItem>
        <ContextMenuItem onClick={() => onRevert(commit.hash)}>Revert</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => onCreateTag(commit.hash)}>Create Tag</ContextMenuItem>
        <ContextMenuItem onClick={() => onViewDiff(commit.hash)}>View Diff</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => onCopyHash(commit.hash)}>
          Copy Hash <span className="ml-auto font-mono text-xs text-muted-foreground">{commit.abbreviatedHash}</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
