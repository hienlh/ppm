/**
 * The icon shown next to an entry in every explorer view.
 *
 * Skins need to swap the folder glyph (a Windows 11 folder looks nothing like a Finder
 * one) without touching the per-extension table, so the folder icon is read from a
 * React context with the Symbols folder as the default. File icons stay shared: VS
 * Code-style file glyphs are the same on all platforms.
 */

import { createContext, useContext, type ComponentProps, type FC } from "react";
import { File as GenericFile, FolderSymlink, HelpCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { fileIconFor, FOLDER_ICON, FOLDER_OPEN_ICON, type SymbolIcon } from "./file-type-icon-map";

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

export interface FileTypeIconProps extends ComponentProps<"svg"> {
  name: string;
  kind: "file" | "directory" | "symlink" | "unknown";
  /** Directories only — draws the open variant (column view, expanded rows). */
  open?: boolean;
}

export function FileTypeIcon({ name, kind, open, className, ...rest }: FileTypeIconProps) {
  const folder = useContext(FolderIconContext);
  const classes = cn("shrink-0", className);

  if (kind === "directory") {
    const Icon = open ? folder.open : folder.closed;
    return <Icon className={classes} {...rest} />;
  }
  if (kind === "symlink") {
    // A link's target may be a file or a directory and is never followed, so it gets its
    // own glyph rather than borrowing one of the two.
    return <FolderSymlink className={cn(classes, "text-text-2")} {...rest} />;
  }
  if (kind === "unknown") {
    // The server timed out reading this entry; showing a file icon would be a lie.
    return <HelpCircle className={cn(classes, "text-text-subtle")} {...rest} />;
  }

  const Icon: FC<ComponentProps<"svg">> | null = fileIconFor(name);
  if (!Icon) return <GenericFile className={cn(classes, "text-text-2")} {...rest} />;
  return <Icon className={classes} {...rest} />;
}
