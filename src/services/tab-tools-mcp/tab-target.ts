import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isAllowedPath, resolvePath } from "../fs-path-guard.service.ts";
import { assertReadPermitted } from "../fs-ops/fs-ops-read-write.service.ts";

/**
 * Turns the `path` an agent passed to `open_file` / `open_preview` into the file a PPM tab
 * opens. A file inside the session's project is named relative to it, the way the file
 * explorer names it, so a tab the user already has open for that file is the one reused; any
 * other file is named by its absolute path, as when the user opens a file from the OS
 * explorer. The rules are the ones the editor's own reads enforce (the PPM directory and
 * `~/.cloudflared` are refused), checked here so the agent hears why instead of the user
 * seeing a tab that cannot load.
 */

export interface TabToolsBinding {
  sessionId: string;
  /** The session's project folder; relative paths resolve against it. */
  projectPath: string | null;
  projectName: string | null;
}

export interface TabTarget {
  filePath: string;
  projectName: string | null;
  /** How the result names the file back to the agent. */
  displayPath: string;
  html: boolean;
  /** The path is a folder, which `open_file` opens in the file browser; `filePath` is then absolute. */
  folder?: true;
}

export type TabTargetOutcome = { ok: true; target: TabTarget } | { ok: false; error: string };

const MAX_PATH_CHARS = 4096;

const isInside = (root: string, path: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * Why the editor's read rules (`assertReadPermitted`) refuse the path, or null when they do not.
 * Also the rule the Assistant's `ui_reveal_path` applies, so both name a path PPM refuses alike.
 */
export function tabReadRefusal(absolute: string, real: string): string | null {
  try {
    assertReadPermitted(absolute, real);
    return null;
  } catch {
    return isAllowedPath(absolute) && isAllowedPath(real)
      ? `PPM does not open ${absolute}: it is in a folder PPM keeps private.`
      : `PPM does not open ${absolute}: it is not on one of this machine's drives.`;
  }
}

export interface TabTargetOptions {
  /** A folder is a target too (`open_file` opens it in the file browser); otherwise it is refused. */
  folder?: boolean;
}

export async function resolveTabTarget(input: unknown, binding: TabToolsBinding, opts: TabTargetOptions = {}): Promise<TabTargetOutcome> {
  if (typeof input !== "string" || !input.trim()) return { ok: false, error: "`path` is required: the file to open." };
  if (input.length > MAX_PATH_CHARS || input.includes("\0")) return { ok: false, error: "`path` is not a valid file path." };
  const raw = input.trim();
  let absolute: string;
  if (isAbsolute(raw) || raw.startsWith("~")) {
    absolute = resolvePath(raw);
  } else if (binding.projectPath) {
    absolute = resolve(binding.projectPath, raw);
  } else {
    return { ok: false, error: "This chat has no project folder, so `path` must be absolute." };
  }
  // The path as given is checked before it reaches the disk, as every other door does: on
  // Windows a UNC path names another machine, and resolving it opens an SMB session there.
  const early = tabReadRefusal(absolute, absolute);
  if (early) return { ok: false, error: early };
  let real: string;
  try {
    real = await realpath(absolute);
  } catch {
    return { ok: false, error: `There is no file at ${absolute}. Write the file first, then call again.` };
  }
  let folder: boolean;
  try {
    const st = await stat(real);
    folder = st.isDirectory();
    if (!folder && !st.isFile()) return { ok: false, error: `${absolute} is not a file or a folder.` };
  } catch {
    return { ok: false, error: `${absolute} could not be read.` };
  }
  if (folder && !opts.folder) return { ok: false, error: `${absolute} is a folder, not a file.` };
  const late = tabReadRefusal(absolute, real);
  if (late) return { ok: false, error: late };
  if (folder) {
    // The file browser names folders absolutely, inside a project or not.
    const root = binding.projectPath ? resolve(binding.projectPath) : null;
    const displayPath = root && isInside(root, absolute) && absolute !== root
      ? relative(root, absolute).split(sep).join("/")
      : absolute;
    return { ok: true, target: { filePath: absolute, projectName: null, displayPath, html: false, folder: true } };
  }
  const html = /\.html?$/i.test(absolute);
  if (binding.projectPath && binding.projectName) {
    const root = resolve(binding.projectPath);
    const realRoot = await realpath(root).catch(() => root);
    if (isInside(root, absolute) && isInside(realRoot, real) && absolute !== root) {
      const filePath = relative(root, absolute).split(sep).join("/");
      return { ok: true, target: { filePath, projectName: binding.projectName, displayPath: filePath, html } };
    }
  }
  return { ok: true, target: { filePath: absolute, projectName: null, displayPath: absolute, html } };
}
