/**
 * Context menu items for a tree node (file or folder).
 */
import { Download } from "lucide-react";
import type { FileNode, ClipboardState } from "@/stores/file-store";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/adaptive-context-menu";

interface TreeNodeContextMenuProps {
  node: FileNode;
  isDir: boolean;
  projectName: string;
  selectedFiles: string[];
  compareSelection: { filePath: string; projectName: string; label: string } | null;
  clipboard: ClipboardState | null;
  onAction: (action: string, node: FileNode) => void;
}

export function TreeNodeContextMenu({
  node,
  isDir,
  projectName,
  selectedFiles,
  compareSelection,
  clipboard,
  onAction,
}: TreeNodeContextMenuProps) {
  return (
    <ContextMenuContent>
      {isDir && (
        <>
          <ContextMenuItem onClick={() => onAction("new-file", node)}>
            New File
          </ContextMenuItem>
          <ContextMenuItem onClick={() => onAction("new-folder", node)}>
            New Folder
          </ContextMenuItem>
          <ContextMenuSeparator />
        </>
      )}
      <ContextMenuItem onClick={() => onAction("cut", node)}>
        Cut
      </ContextMenuItem>
      <ContextMenuItem onClick={() => onAction("copy-file", node)}>
        Copy
      </ContextMenuItem>
      {isDir && clipboard && (
        <ContextMenuItem onClick={() => onAction("paste", node)}>
          Paste
        </ContextMenuItem>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => onAction("rename", node)}>
        Rename
      </ContextMenuItem>
      <ContextMenuItem
        variant="destructive"
        onClick={() => onAction("delete", node)}
      >
        Delete
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => onAction("copy-path", node)}>
        Copy Path
      </ContextMenuItem>
      <ContextMenuItem onClick={() => onAction("copy-full-path", node)}>
        Copy Full Path
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => onAction("download", node)}>
        <Download className="size-3.5 mr-2" />
        Download{isDir ? " as Zip" : ""}
      </ContextMenuItem>
      {!isDir && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => onAction("select-for-compare", node)}>
            Select for Compare
          </ContextMenuItem>
          {compareSelection && compareSelection.projectName === projectName && compareSelection.filePath !== node.path && (
            <ContextMenuItem onClick={() => onAction("compare-with-selected", node)}>
              Compare with Selected ({compareSelection.label})
            </ContextMenuItem>
          )}
        </>
      )}
      {!isDir && selectedFiles.length === 2 && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => onAction("compare-selected", node)}>
            Compare Selected
          </ContextMenuItem>
        </>
      )}
    </ContextMenuContent>
  );
}
