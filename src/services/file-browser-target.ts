import { readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { isAllowedPath, resolvePath } from "./fs-path-guard.service.ts";
import { tabReadRefusal } from "./tab-tools-mcp/tab-target.ts";
import {
  assistantPrivateScope, isAssistantPrivatePath, type AssistantPrivateScope,
} from "./assistant/assistant-private-paths.ts";

/**
 * Where the OS file browser (the File Explorer window, the full-screen sheet on a phone) should
 * open for a path someone else named: the Assistant's `ui_open_file_browser`, a `/files?path=`
 * link, a path in an AI answer the user taps. A folder opens as itself; a file opens its folder
 * with the file selected.
 *
 * One rule set for all three, and the strictest of the ones PPM already has, because each of them
 * puts a name on screen the user did not type: the editor's read rules (PPM's own folder,
 * `~/.cloudflared`, nothing off this machine's drives) and the stores the Assistant treats as
 * private (`~/.ssh`, `~/.aws`, the database snapshots…). A refusal that can be decided from the
 * path as written is decided before the disk is touched, and a refusal after following links never
 * names where the link leads, so the answer never says which keys exist.
 */

export interface FileBrowserTarget {
  /** The folder the browser opens, absolute. */
  dir: string;
  /** The file to select in it, absolute; null when the path named a folder. */
  select: string | null;
  kind: "folder" | "file";
}

export type FileBrowserOutcome = { ok: true; value: FileBrowserTarget } | { ok: false; error: string };

export interface FileBrowserTargetOptions {
  /** What a relative path resolves against (a chat's project); relative paths are refused without it. */
  baseDir?: string | null;
  /** The private-store rule, built once per batch; built from the registered projects when omitted. */
  scope?: AssistantPrivateScope;
  /** Every registered project's folder, read when `scope` is not given. */
  projectRoots?: () => string[];
}

export const MAX_FILE_BROWSER_PATH_CHARS = 4096;

const foldCase = process.platform === "win32" || process.platform === "darwin";
const fold = (p: string) => (foldCase ? p.toLowerCase() : p);
const isInside = (root: string, path: string): boolean => {
  const r = fold(root), p = fold(path);
  return p === r || p.startsWith(r.endsWith(sep) ? r : r + sep);
};

const PRIVATE = "is where logins or keys are kept; PPM does not open it from here. Open it yourself if you need it.";

/** The private-store rule for the projects registered now. */
export function fileBrowserScope(projectRoots: string[]): AssistantPrivateScope {
  return assistantPrivateScope({ projectRoots });
}

/** The nearest folder above `path` that exists, followed through links; null at the root. */
async function nearestRealFolder(path: string): Promise<string | null> {
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    const real = await realpath(dir).catch(() => null);
    if (real) return real;
    if (dirname(dir) === dir) return null;
  }
}

export async function resolveFileBrowserTarget(input: unknown, opts: FileBrowserTargetOptions = {}): Promise<FileBrowserOutcome> {
  if (typeof input !== "string" || !input.trim()) {
    return { ok: false, error: "`path` is required: an absolute folder or file path (\"~\" for the home folder)." };
  }
  if (input.length > MAX_FILE_BROWSER_PATH_CHARS || input.includes("\0")) return { ok: false, error: "`path` is not a valid path." };
  const raw = input.trim();
  let absolute: string;
  if (isAbsolute(raw) || raw.startsWith("~")) absolute = resolvePath(raw);
  else if (opts.baseDir) absolute = resolve(opts.baseDir, raw);
  else return { ok: false, error: `${raw} is relative; give an absolute path ("~" for the home folder).` };

  if (!isAllowedPath(absolute)) return { ok: false, error: `${absolute} is not on one of this machine's drives.` };
  const early = tabReadRefusal(absolute, absolute);
  if (early) return { ok: false, error: early };
  const scope = opts.scope ?? fileBrowserScope(opts.projectRoots?.() ?? []);
  if (isAssistantPrivatePath(absolute, scope)) return { ok: false, error: `${absolute} ${PRIVATE}` };

  /** Why a real location may not be opened, or null. Never names where a link leads. */
  const refuseReal = (where: string): string | null => {
    if (!isAllowedPath(where)) return `${absolute} leads off this machine's drives through a link.`;
    const late = tabReadRefusal(absolute, where);
    if (late) return late;
    if (isAssistantPrivatePath(where, scope)) return `${absolute} ${PRIVATE}`;
    return null;
  };

  let real: string;
  try {
    real = await realpath(absolute);
  } catch {
    // Judged by where the nearest existing folder really is: behind a link into `~/.ssh`,
    // "nothing at id_rsa" beside a refusal for id_ed25519 would say which keys exist.
    const nearest = await nearestRealFolder(absolute);
    return { ok: false, error: (nearest ? refuseReal(nearest) : null) ?? `There is nothing at ${absolute}.` };
  }
  const refused = refuseReal(real);
  if (refused) return { ok: false, error: refused };

  let folder: boolean;
  try {
    folder = (await stat(real)).isDirectory();
  } catch {
    return { ok: false, error: `${absolute} could not be read.` };
  }
  if (folder) return { ok: true, value: { dir: absolute, select: null, kind: "folder" } };

  // The folder lists the file under the name the disk stores, so a path typed in the wrong case
  // still selects its row.
  const parent = dirname(absolute);
  const realParent = await realpath(parent).catch(() => null);
  if (!realParent) return { ok: false, error: `${absolute} could not be read.` };
  const parentRefused = refuseReal(realParent);
  if (parentRefused) return { ok: false, error: parentRefused };
  const want = basename(absolute);
  const names = await readdir(parent).catch(() => [] as string[]);
  const stored = names.includes(want) ? want : names.find((n) => fold(n) === fold(want)) ?? want;
  return { ok: true, value: { dir: parent, select: join(parent, stored), kind: "file" } };
}

/** Whether `path` lies inside `root` (case-folded where the disk ignores case). */
export function isInsideFolder(root: string, path: string): boolean {
  return isInside(resolve(root), resolve(path));
}
