import { readdir, readlink, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
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
 *
 * Every disk call has a deadline: a finished AI answer has each path it names checked before anyone
 * clicks, and a dead network drive or a sleeping disk would otherwise hold the request for minutes.
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

const PRIVATE = "is where logins or keys are kept; PPM does not open it from here. Open it yourself if you need it.";

/** The private-store rule for the projects registered now. */
export function fileBrowserScope(projectRoots: string[]): AssistantPrivateScope {
  return assistantPrivateScope({ projectRoots });
}

/** How long one disk call may take before the path is answered "could not be read". */
const DISK_DEADLINE_MS = 1_500;
const TIMED_OUT = Symbol("timed out");
type Late = typeof TIMED_OUT;

async function bounded<T>(work: Promise<T>): Promise<T | Late> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<Late>((done) => { timer = setTimeout(() => done(TIMED_OUT), DISK_DEADLINE_MS); });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}
const realOrNull = (p: string): Promise<string | null | Late> => bounded(realpath(p).catch(() => null));

/**
 * Folders that mount another machine when merely looked at (autofs `/net` on Linux and macOS,
 * macOS's `/Network`): resolving a path under them — which an answer naming one would do before
 * anyone clicked — opens a connection to a host the text chose. UNC paths are already refused.
 */
const NETWORK_ROOTS = ["/net", "/Network"];
const underNetworkRoot = (p: string) => process.platform !== "win32"
  && NETWORK_ROOTS.some((root) => p === root || p.startsWith(`${root}/`));

/** The nearest folder at or above `path` that exists, followed through links; null at the root. */
async function nearestRealFolder(path: string): Promise<string | null | Late> {
  for (let dir = path; ; dir = dirname(dir)) {
    const real = await realOrNull(dir);
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
  if (underNetworkRoot(absolute)) return { ok: false, error: `${absolute} is on a network mount; PPM does not open it from here.` };
  const early = tabReadRefusal(absolute, absolute);
  if (early) return { ok: false, error: early };
  const scope = opts.scope ?? fileBrowserScope(opts.projectRoots?.() ?? []);
  if (isAssistantPrivatePath(absolute, scope)) return { ok: false, error: `${absolute} ${PRIVATE}` };
  const unreadable: FileBrowserOutcome = { ok: false, error: `${absolute} could not be read.` };

  /** Why a real location may not be opened, or null. Never names where a link leads. */
  const refuseReal = (where: string): string | null => {
    if (!isAllowedPath(where) || underNetworkRoot(where)) return `${absolute} leads off this machine's drives through a link.`;
    const late = tabReadRefusal(absolute, where);
    if (late) return late;
    if (isAssistantPrivatePath(where, scope)) return `${absolute} ${PRIVATE}`;
    return null;
  };

  const real = await realOrNull(absolute);
  if (real === TIMED_OUT) return unreadable;
  if (!real) {
    // Judged by where the nearest existing folder really is — following a dangling link at the end
    // too: behind a link into `~/.ssh`, "nothing at id_rsa" beside a refusal for id_ed25519 would
    // say which keys exist.
    const link = await bounded(readlink(absolute).catch(() => null));
    if (link === TIMED_OUT) return unreadable;
    const nearest = await nearestRealFolder(link ? resolve(dirname(absolute), link) : dirname(absolute));
    if (nearest === TIMED_OUT) return unreadable;
    return { ok: false, error: (nearest ? refuseReal(nearest) : null) ?? `There is nothing at ${absolute}.` };
  }
  const refused = refuseReal(real);
  if (refused) return { ok: false, error: refused };

  const st = await bounded(stat(real).catch(() => null));
  if (!st || st === TIMED_OUT) return unreadable;
  if (st.isDirectory()) return { ok: true, value: { dir: absolute, select: null, kind: "folder" } };

  const parent = dirname(absolute);
  const realParent = await realOrNull(parent);
  if (!realParent || realParent === TIMED_OUT) return unreadable;
  const parentRefused = refuseReal(realParent);
  if (parentRefused) return { ok: false, error: parentRefused };
  // Where the disk ignores case, the folder lists the file under the name it stores, so a path
  // typed in the wrong case still selects its row. Elsewhere the name as given is the stored one.
  const want = basename(absolute);
  let stored = want;
  if (foldCase) {
    const names = await bounded(readdir(parent).catch(() => [] as string[]));
    if (names !== TIMED_OUT && !names.includes(want)) stored = names.find((n) => fold(n) === fold(want)) ?? want;
  }
  return { ok: true, value: { dir: parent, select: join(parent, stored), kind: "file" } };
}
