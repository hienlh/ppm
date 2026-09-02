import { MacFolderIcon, MacFolderOpenIcon } from "./folder-icon-macos";
import { MacosWindowChrome } from "./macos-window-chrome";
import type { ExplorerSkin } from "./skin-types";

export const macosSkin: ExplorerSkin = {
  id: "macos",
  // Finder's sidebar shows one "Locations" group in principle, but this sidebar renders
  // known folders and drives as two separate sections — reusing the same title would look
  // like a duplicated header, so drives get their own distinct label.
  vocab: { home: "Home", pinned: "Favorites", known: "Locations", drives: "Devices" },
  FolderIcon: MacFolderIcon,
  FolderOpenIcon: MacFolderOpenIcon,
  chrome: MacosWindowChrome,
};
