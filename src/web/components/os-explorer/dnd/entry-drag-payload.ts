/**
 * The payload every PPM entry drag carries, and the pure path guards that decide whether a
 * drop is allowed at all.
 *
 * One MIME type for the whole app: a tab drag (`application/ppm-tab`) and an entry drag are
 * told apart by `dataTransfer.types` alone, so a tab dropped on a folder and a folder
 * dropped on the tab bar both do nothing instead of doing the wrong thing.
 *
 * Paths are always absolute host paths, including the ones a project tree contributes —
 * that is the only address space the explorer and the tree share.
 */

export const ENTRY_DRAG_MIME = "application/x-ppm-paths";

/** Legacy single-path type the project tree already used for its own internal moves. */
export const TREE_LEGACY_DRAG_MIME = "application/x-ppm-path";

export type EntryDragOrigin = "explorer" | "tree";

export type DropOperation = "copy" | "move";

export interface EntryDragPayload {
  /** Absolute host paths. */
  paths: string[];
  origin: EntryDragOrigin;
  /** Present when the drag started in a project tree — a tree-internal drop keeps its own routes. */
  projectName?: string;
}

/** Windows paths are case-insensitive; a drive letter or a UNC prefix is the cheap tell. */
function isWindowsPath(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

/**
 * Comparable form of a path: one separator style, no trailing separator, case-folded on
 * Windows. Only ever used for comparisons — never for building a path to send to the server.
 */
export function normalisePath(path: string): string {
  const unified = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return isWindowsPath(path) ? unified.toLowerCase() : unified;
}

/** Host separator implied by a path, for the helpers that have no `HostInfo` at hand. */
export function sepOf(path: string): string {
  return isWindowsPath(path) || path.includes("\\") ? "\\" : "/";
}

export function encodeEntryDrag(payload: EntryDragPayload): string {
  return JSON.stringify(payload);
}

/** Tolerant decode — a foreign or truncated payload is "not our drag", never a throw. */
export function decodeEntryDrag(raw: string | null | undefined): EntryDragPayload | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as Partial<EntryDragPayload>;
  if (!Array.isArray(candidate.paths)) return null;
  const paths = candidate.paths.filter((p): p is string => typeof p === "string" && p.length > 0);
  if (paths.length === 0) return null;
  const payload: EntryDragPayload = {
    paths,
    origin: candidate.origin === "tree" ? "tree" : "explorer",
  };
  if (typeof candidate.projectName === "string") payload.projectName = candidate.projectName;
  return payload;
}

/**
 * True when `targetDir` is one of the dragged entries or lives inside one — moving a folder
 * into itself would either delete it or produce infinite nesting, so it is refused outright.
 */
export function isSelfOrDescendant(paths: string[], targetDir: string): boolean {
  const target = normalisePath(targetDir);
  return paths.some((path) => {
    const source = normalisePath(path);
    return target === source || target.startsWith(`${source}/`);
  });
}

/** True when every dragged entry already sits directly in `targetDir` — a move would be a no-op. */
export function allAlreadyIn(paths: string[], targetDir: string): boolean {
  const target = normalisePath(targetDir);
  return paths.every((path) => {
    const source = normalisePath(path);
    const cut = source.lastIndexOf("/");
    const parent = cut <= 0 ? source.slice(0, cut + 1) : source.slice(0, cut);
    return parent === target;
  });
}

/**
 * Move is the default; `Ctrl` (and `Alt`, which is macOS's own copy modifier) switches to
 * copy. Read again at drop time, because the user is allowed to change their mind mid-drag.
 */
export function resolveDropOperation(modifiers: { ctrlKey: boolean; altKey: boolean }): DropOperation {
  return modifiers.ctrlKey || modifiers.altKey ? "copy" : "move";
}

/** `text/uri-list` mirror of the payload, so non-PPM drop targets see something meaningful. */
export function toFileUriList(paths: string[]): string {
  return paths
    .map((path) => {
      const unified = path.replace(/\\/g, "/");
      const absolute = unified.startsWith("/") ? unified : `/${unified}`;
      return `file://${absolute.split("/").map(encodeURIComponent).join("/")}`;
    })
    .join("\r\n");
}
