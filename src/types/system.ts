/** Server-side host facts the frontend cannot learn on its own: OS, path
 *  separator, home dir, drives/volumes, resolved known folders, and the
 *  user's OS-pinned folders (Windows Quick Access, Finder Favorites,
 *  GTK/KDE bookmarks). Backs `GET /api/system/host`. */
export interface HostInfo {
  platform: "win32" | "darwin" | "linux";
  sep: "\\" | "/";
  homedir: string;
  hostname: string;
  drives: Drive[];
  knownFolders: KnownFolder[];
  pinned: PinnedFolder[];
  /** Non-fatal provider failures — a failure never becomes a 500, it becomes text here. */
  warnings: string[];
}

export type DriveKind = "fixed" | "removable" | "network" | "unknown";

export interface Drive {
  /** Display label for the mount, e.g. "C:" or "Macintosh HD". */
  name: string;
  /** Filesystem path to browse into, e.g. "C:\\" or "/Volumes/External". */
  path: string;
  kind: DriveKind;
  /** Volume label when the OS reports one (Windows CIM `VolumeName`). */
  label?: string;
}

export type KnownFolderKey =
  | "desktop"
  | "documents"
  | "downloads"
  | "pictures"
  | "music"
  | "videos"
  | "icloud";

export interface KnownFolder {
  key: KnownFolderKey;
  name: string;
  path: string;
}

export type PinnedSource = "quick-access" | "finder-favorites" | "gtk" | "kde";

export interface PinnedFolder {
  name: string;
  path: string;
  source: PinnedSource;
}
