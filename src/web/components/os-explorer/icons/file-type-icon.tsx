/**
 * The icon shown next to an entry in every explorer view.
 *
 * Skins need to swap the folder glyph (a Windows 11 folder looks nothing like a Finder
 * one) without touching the per-extension table, so the folder icon is read from a
 * React context with the Symbols folder as the default. File icons are the app's own
 * (`@/lib/file-icons`, the vscode-icons theme): a `.ts` file should look the same in
 * this window as in the editor's tree, and only the *folder* is a platform idiom.
 */

import { createContext, useContext, type ComponentProps } from "react";
import { FolderSymlink, HelpCircle } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { FileIcon } from "@/lib/file-icons";
import { FOLDER_ICON, FOLDER_OPEN_ICON, type SymbolIcon } from "./file-type-icon-map";

export interface FolderIconSlot {
  closed: SymbolIcon;
  open: SymbolIcon;
}

const FolderIconContext = createContext<FolderIconSlot>({
  closed: FOLDER_ICON,
  open: FOLDER_OPEN_ICON,
});

/** Skin hook: wrap a subtree to replace the folder glyphs it renders. */
export const FolderIconProvider = FolderIconContext.Provider;

// `className` is the only prop any call site passes, and the file branch is no
// longer an SVG element — so the props are spelled out rather than inherited
// from `ComponentProps<"svg">`.
export interface FileTypeIconProps {
  className?: string;
  name: string;
  kind: "file" | "directory" | "symlink" | "unknown";
  /** Directories only — draws the open variant (column view, expanded rows). */
  open?: boolean;
}

export function FileTypeIcon({ name, kind, open, className }: FileTypeIconProps) {
  const folder = useContext(FolderIconContext);
  const classes = cn("shrink-0", className);

  if (kind === "directory") {
    const Icon = open ? folder.open : folder.closed;
    return <Icon className={classes} />;
  }
  if (kind === "symlink") {
    // A link's target may be a file or a directory and is never followed, so it gets its
    // own glyph rather than borrowing one of the two.
    return <FolderSymlink className={cn(classes, "text-text-2")} />;
  }
  if (kind === "unknown") {
    // The server timed out reading this entry; showing a file icon would be a lie.
    return <HelpCircle className={cn(classes, "text-text-subtle")} />;
  }

  return <FileIcon name={name} className={classes} />;
}
