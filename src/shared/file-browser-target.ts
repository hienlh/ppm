/**
 * Shapes shared by the server's path resolver for the OS file browser (`POST /api/fs/locate`) and
 * the browser code that opens it: the `/files?path=` link, a path in an AI answer, the
 * Assistant's `ui_open_file_browser`.
 */

/** At most this many paths are checked in one request. */
export const MAX_LOCATE_PATHS = 100;

export interface FileBrowserLocateRequest {
  paths: string[];
  /** The chat's project: relative paths resolve against its folder. */
  project?: string;
}

/** One answer per path asked, in the same order. */
export type FileBrowserLocateEntry =
  | { input: string; ok: true; kind: "folder" | "file"; dir: string; select: string | null }
  | { input: string; ok: false; error: string };

export interface FileBrowserLocateResponse {
  results: FileBrowserLocateEntry[];
}

/** The app path that opens the file browser at a folder or file. */
export const FILE_BROWSER_ROUTE = "/files";

/** A link that opens the file browser at `path`, on `base` (an origin, or "" for the current one). */
export function fileBrowserLink(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${FILE_BROWSER_ROUTE}?path=${encodeURIComponent(path)}`;
}

/** The path a `/files?path=` address asks for, or null when it is not one. */
export function fileBrowserPathFromLocation(pathname: string, search: string): string | null {
  if (!/^\/files\/?$/.test(pathname)) return null;
  const path = new URLSearchParams(search).get("path");
  return path && path.trim() ? path : null;
}
