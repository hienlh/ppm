/**
 * The folder glyph an explorer skin starts from.
 *
 * This file used to hold a curated extension → glyph table as well, from the
 * Symbols set. File icons now come from `@/lib/file-icons` — the vscode-icons
 * theme the whole app uses — so that a `.ts` file looks the same here as in the
 * editor's tree. What stays is the *folder*, because that is the part each skin
 * replaces: a Windows 11 folder looks nothing like a Finder one.
 *
 * Imports come from the `/folders` subpath only. The root barrel pulls the whole
 * library (900+ icons) into the graph and `/utils` drags in a lookup table that
 * defeats tree-shaking; naming each icon explicitly keeps the built chunk to the
 * glyphs actually referenced.
 */

import type { FC, ComponentProps } from "react";
import { Folder, FolderOpen } from "@react-symbols/icons/folders";

export type SymbolIcon = FC<ComponentProps<"svg">>;

export const FOLDER_ICON: SymbolIcon = Folder;
export const FOLDER_OPEN_ICON: SymbolIcon = FolderOpen;
