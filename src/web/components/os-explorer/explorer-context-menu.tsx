/**
 * The explorer's context menu. One component covers both cases: a right-click on rows
 * (`targets` non-empty) and a right-click on empty space (`targets` empty), because the
 * OS menus differ only in which items appear.
 *
 * Rendered through the adaptive menu, so it is a bottom sheet on phones and a radix menu
 * everywhere else.
 */

import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/adaptive-context-menu";
import { useIsMobile } from "@/hooks/use-is-mobile";
import type { FsEntry } from "@/lib/fs-api";
import { canOpenInPpm } from "./can-open-in-ppm";
import type { ExplorerActions } from "./actions/use-explorer-actions";
import { useExplorerStore, type SortDir, type SortKey } from "./explorer-store";
import { SORT_DIR_OPTIONS, SORT_KEY_OPTIONS } from "./sort-options";

export interface ExplorerContextMenuProps {
  /** Entries the menu acts on; empty means the folder background. */
  targets: FsEntry[];
  currentDir: string;
  hasClipboard: boolean;
  isPinned(path: string): boolean;
  actions: ExplorerActions;
}

export function ExplorerContextMenu({
  targets, currentDir, hasClipboard, isPinned, actions,
}: ExplorerContextMenuProps) {
  // The mobile sheet is a single instance — "Open in New Window" would spawn a desktop
  // floating window that `WindowLayer` never renders below `md`, a silent no-op there.
  const isMobile = useIsMobile();
  const single = targets.length === 1 ? targets[0]! : null;
  const onlyDirs = targets.length > 0 && targets.every((e) => e.type === "directory");
  const count = targets.length;
  const suffix = count > 1 ? ` ${count} items` : "";
  const sort = useExplorerStore((s) => s.sort);
  const setPrefs = useExplorerStore((s) => s.setPrefs);

  if (count === 0) {
    return (
      <ContextMenuContent>
        <ContextMenuItem onClick={() => actions.startCreate("new-file")}>New File</ContextMenuItem>
        <ContextMenuItem onClick={() => actions.startCreate("new-folder")}>New Folder</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={!hasClipboard} onClick={() => actions.paste()}>Paste</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => actions.openUploadPicker()}>Upload Files…</ContextMenuItem>
        {actions.supportsFolderUpload && (
          <ContextMenuItem onClick={() => actions.openUploadFolderPicker()}>Upload Folder…</ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => actions.openInTerminal()}>Open in Terminal</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuSub>
          <ContextMenuSubTrigger>Sort by</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuRadioGroup
              value={sort.key}
              onValueChange={(key) => setPrefs({ sort: { key: key as SortKey, dir: sort.dir } })}
            >
              {SORT_KEY_OPTIONS.map(({ key, label }) => (
                <ContextMenuRadioItem key={key} value={key}>{label}</ContextMenuRadioItem>
              ))}
            </ContextMenuRadioGroup>
            <ContextMenuSeparator />
            <ContextMenuRadioGroup
              value={sort.dir}
              onValueChange={(dir) => setPrefs({ sort: { key: sort.key, dir: dir as SortDir } })}
            >
              {SORT_DIR_OPTIONS.map(({ dir, label }) => (
                <ContextMenuRadioItem key={dir} value={dir}>{label}</ContextMenuRadioItem>
              ))}
            </ContextMenuRadioGroup>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => actions.copyPath([currentDir])}>Copy Path</ContextMenuItem>
      </ContextMenuContent>
    );
  }

  return (
    <ContextMenuContent>
      {single && (single.type === "directory" || canOpenInPpm(single.name)) && (
        <ContextMenuItem onClick={() => actions.openEntry(single)}>Open</ContextMenuItem>
      )}
      {onlyDirs && single && !isMobile && (
        <ContextMenuItem onClick={() => actions.openInNewWindow(single)}>
          Open in New Window
        </ContextMenuItem>
      )}
      {onlyDirs && single && (
        <ContextMenuItem onClick={() => actions.openInTerminal(single)}>Open in Terminal</ContextMenuItem>
      )}
      <ContextMenuSeparator />

      <ContextMenuItem onClick={() => actions.cut(targets)}>Cut{suffix}</ContextMenuItem>
      <ContextMenuItem onClick={() => actions.copy(targets)}>Copy{suffix}</ContextMenuItem>
      {onlyDirs && single && (
        <ContextMenuItem disabled={!hasClipboard} onClick={() => actions.paste(single.path)}>
          Paste
        </ContextMenuItem>
      )}
      <ContextMenuSeparator />

      {single && <ContextMenuItem onClick={() => actions.startRename(single)}>Rename</ContextMenuItem>}
      <ContextMenuItem onClick={() => actions.trash(targets)}>Move to Trash{suffix}</ContextMenuItem>
      <ContextMenuItem variant="destructive" onClick={() => actions.confirmPermanentDelete(targets)}>
        Delete permanently
      </ContextMenuItem>
      <ContextMenuSeparator />

      <ContextMenuItem onClick={() => actions.copyPath(targets.map((e) => e.path))}>Copy Path</ContextMenuItem>
      <ContextMenuItem onClick={() => actions.copyName(targets.map((e) => e.name))}>Copy Name</ContextMenuItem>
      {targets.some((e) => e.type === "file") && (
        <ContextMenuItem onClick={() => actions.download(targets)}>Download</ContextMenuItem>
      )}
      {onlyDirs && single && (
        <ContextMenuItem onClick={() => actions.togglePin(single.path, single.name)}>
          {isPinned(single.path) ? "Unpin from Sidebar" : "Pin to Sidebar"}
        </ContextMenuItem>
      )}
      {single && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => actions.showProperties(single)}>Properties</ContextMenuItem>
        </>
      )}
    </ContextMenuContent>
  );
}
