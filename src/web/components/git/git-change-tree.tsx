/**
 * Source Control's "group by folder" view: the changed files as a tree, with a
 * chain of single-child folders joined into one row (`compactTree`).
 */
import { useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Trash2 } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { allCheckState, hasUnstaged } from "@/lib/git-changes-view";
import { buildTree, collectFiles, compactTree, type TreeNode } from "@/lib/git-file-tree";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/adaptive-context-menu";
import type { ChangedFile } from "../../../shared/git-changes";
import { CheckCell, CountChip } from "./git-change-parts";
import { GitChangeRow, type ChangeRowActions } from "./git-change-row";

/** Indent per nesting level, and where that level's guide line sits inside it. */
const TREE_INDENT = 14;
const TREE_GUIDE_X = 7;

export interface FolderActions {
  /** The folder's checkbox: stage what is in it, or unstage it all once it is all staged. */
  onToggleFolder: (files: ChangedFile[]) => void;
  onDiscardFolder: (files: ChangedFile[], folder: string, anchor: HTMLElement) => void;
}

export function GitChangeTree({ files, busy, actions, folderActions }: {
  files: ChangedFile[];
  busy: boolean;
  actions: ChangeRowActions;
  folderActions: FolderActions;
}) {
  const tree = useMemo(() => compactTree(buildTree(files)), [files]);
  return (
    <div>
      {tree.map((node) => (
        <TreeNodeView
          key={node.fullPath}
          node={node}
          depth={0}
          busy={busy}
          actions={actions}
          folderActions={folderActions}
        />
      ))}
    </div>
  );
}

function TreeNodeView({ node, depth, busy, actions, folderActions }: {
  node: TreeNode<ChangedFile>;
  depth: number;
  busy: boolean;
  actions: ChangeRowActions;
  folderActions: FolderActions;
}) {
  const [expanded, setExpanded] = useState(true);
  const rowRef = useRef<HTMLDivElement>(null);

  if (node.file) {
    return (
      <div style={{ paddingLeft: depth * TREE_INDENT }}>
        <GitChangeRow file={node.file} nested busy={busy} actions={actions} />
      </div>
    );
  }
  if (!node.children.length) return null;

  const folderFiles = collectFiles(node);
  const state = allCheckState(folderFiles);
  const discardable = folderFiles.filter(hasUnstaged);
  const lastSlash = node.name.lastIndexOf("/");
  const folderPrefix = lastSlash >= 0 ? node.name.slice(0, lastSlash + 1) : "";
  const folderLeaf = lastSlash >= 0 ? node.name.slice(lastSlash + 1) : node.name;
  const discard = (anchor: HTMLElement | null) => {
    if (anchor) folderActions.onDiscardFolder(discardable, node.fullPath, anchor);
  };

  return (
    <div>
      {/* Long-press is the gesture for the menu; a tap on the folder's own
          button expands it, which a dropdown trigger here once prevented. */}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={rowRef}
            className="group relative flex min-h-14 md:min-h-8 items-stretch select-none can-hover:hover:bg-surface-hover"
            style={{ paddingLeft: depth * TREE_INDENT }}
          >
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-1.5 pl-1.5 text-left text-sm md:text-[13px] text-text-2"
              onClick={() => setExpanded(!expanded)}
              aria-expanded={expanded}
            >
              {expanded ? (
                <ChevronDown className="size-4 shrink-0 text-text-3" />
              ) : (
                <ChevronRight className="size-4 shrink-0 text-text-3" />
              )}
              {/*
               * A compacted name is a path, and for a path the last segment is
               * the specific one — so the leading ones are what may be dropped,
               * and they are dimmed to read as context rather than as the
               * folder's own name. One inline flow inside the isolate, not two
               * flex children: the row's gap would otherwise open a space
               * inside the path, between `web/` and `components`.
               */}
              <span dir="rtl" className="min-w-0 flex-1 truncate text-left">
                <bdi>
                  {folderPrefix && <span className="opacity-55">{folderPrefix}</span>}
                  <span className="font-medium">{folderLeaf}</span>
                </bdi>
              </span>
              <CountChip count={folderFiles.length} />
            </button>
            {discardable.length > 0 && (
              <div
                className={cn(
                  "hidden md:flex items-center pl-1 transition-opacity",
                  "can-hover:opacity-0 can-hover:group-hover:opacity-100 focus-within:opacity-100",
                )}
              >
                <button
                  type="button"
                  className="grid size-6 place-items-center rounded-[5px] text-text-3 hover:bg-text/8 hover:text-error"
                  title="Discard changes in this folder…"
                  aria-label={`Discard changes in ${node.fullPath}`}
                  disabled={busy}
                  onClick={(e) => discard(e.currentTarget)}
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            )}
            <CheckCell
              state={state}
              disabled={busy}
              label={`${state === "all" ? "Unstage" : "Stage"} ${node.fullPath}`}
              title={state === "all" ? "Unstage folder" : "Stage folder"}
              onToggle={() => folderActions.onToggleFolder(folderFiles)}
            />
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-40">
          <ContextMenuItem onClick={() => folderActions.onToggleFolder(folderFiles)} disabled={busy}>
            {state === "all" ? "Unstage" : "Stage"} {node.name}/
          </ContextMenuItem>
          {discardable.length > 0 && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem variant="destructive" onClick={() => discard(rowRef.current)} disabled={busy}>
                Discard changes…
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
      {/*
       * One continuous guide per level, drawn here by the parent rather than
       * as a segment per child: a single line owned by the container it groups
       * cannot drift from its rows, the way hand-placed elbows on rows of two
       * heights once did. Dropping the elbows is what VS Code's tree does.
       */}
      {expanded && (
        <div className="relative">
          <span
            aria-hidden
            className="absolute top-0 bottom-0 w-px bg-border/70"
            style={{ left: depth * TREE_INDENT + TREE_GUIDE_X }}
          />
          {node.children.map((child) => (
            <TreeNodeView
              key={child.fullPath}
              node={child}
              depth={depth + 1}
              busy={busy}
              actions={actions}
              folderActions={folderActions}
            />
          ))}
        </div>
      )}
    </div>
  );
}
