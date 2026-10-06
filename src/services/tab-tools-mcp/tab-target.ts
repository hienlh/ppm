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
}

export type TabTargetOutcome = { ok: true; target: TabTarget } | { ok: false; error: string };

const MAX_PATH_CHARS = 4096;

const isInside = (root: string, path: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

/** Why the editor's read rules (`assertReadPermitted`) refuse the path, or null when they do not. */
function refusal(absolute: string, real: string): string | null {
  try {
    assertReadPermitted(absolute, real);
    return null;
  } catch {
    return isAllowedPath(absolute) && isAllowedPath(real)
      ? `PPM does not open ${absolute}: it is in a folder PPM keeps private.`
      : `PPM does not open ${absolute}: it is not on one of this machine's drives.`;
  }
}

export async function resolveTabTarget(input: unknown, binding: TabToolsBinding): Promise<TabTargetOutcome> {
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
  const early = refusal(absolute, absolute);
  if (early) return { ok: false, error: early };
  let real: string;
  try {
    real = await realpath(absolute);
  } catch {
    return { ok: false, error: `There is no file at ${absolute}. Write the file first, then call again.` };
  }
  try {
    if (!(await stat(real)).isFile()) return { ok: false, error: `${absolute} is a folder, not a file.` };
  } catch {
    return { ok: false, error: `${absolute} could not be read.` };
  }
  const late = refusal(absolute, real);
  if (late) return { ok: false, error: late };
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
