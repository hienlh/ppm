import { WindowsFolderIcon, WindowsFolderOpenIcon } from "./folder-icon-windows";
import { WindowsWindowChrome } from "./windows-window-chrome";
import type { ExplorerSkin } from "./skin-types";

export const windowsSkin: ExplorerSkin = {
  id: "windows",
  vocab: { home: "Home", pinned: "Quick access", known: "Folders", drives: "Drives" },
  FolderIcon: WindowsFolderIcon,
  FolderOpenIcon: WindowsFolderOpenIcon,
  chrome: WindowsWindowChrome,
};
