import { homedir } from "node:os";
import { dirname, isAbsolute, relative } from "node:path";
import { isCredentialPath } from "./fs-credential-path-guard.ts";
import { getPpmDir } from "./ppm-dir.ts";
import { assistantPrivateRoots, isHomeStateEntry } from "./assistant/assistant-private-paths.ts";
import { isInside } from "./design/design-tool-policy.ts";

/**
 * Why an AI must not register (or move a project to) the folder `abs`, or null when it may ask
 * to. Registering a folder is what lets the PPM Assistant read inside it without asking, so a
 * folder that would put any of these inside a project is refused before anyone is asked:
 *
 *  - a whole drive, the home folder or anything holding it;
 *  - PPM's own data folder and credentials;
 *  - the home folder's application-state area (`~/.config`, `~/.mozilla`, `~/AppData`,
 *    `~/Library`…), where browsers and tools keep their logins;
 *  - any folder in or holding a store the Assistant never reads unasked (`~/.ssh`, the
 *    Cloudflare login, the database snapshots…).
 *
 * The user can still add such a folder themselves from PPM's project switcher. Shared by the
 * Assistant's `project_add` / `project_update` and by `ppm projects add|move|clone` run from an AI
 * chat, where it is advisory: the shell's approval card is the real control there.
 */
export interface FolderRefusalOptions {
  platform?: string;
  /** The private stores; defaults to the Assistant's own list for `home`. */
  privateRoots?: readonly string[];
}

const plainInside = (child: string, parent: string): boolean => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** The first folder name below `home` on the way to `abs`, or null when `abs` is not below it. */
function firstSegmentBelow(abs: string, home: string): string | null {
  if (!isInside(abs, home)) return null;
  const fold = process.platform === "win32" || process.platform === "darwin";
  const rel = relative(fold ? home.toLowerCase() : home, fold ? abs.toLowerCase() : abs);
  if (!rel || isAbsolute(rel)) return null;
  // Read from `abs` itself, so the message spells the folder as the user does.
  return abs.slice(abs.length - rel.length).split(/[\\/]/)[0]!;
}

export function projectFolderRefusal(
  abs: string,
  home: string = homedir(),
  ppmDir: string = getPpmDir(),
  opts: FolderRefusalOptions = {},
): string | null {
  const platform = opts.platform ?? process.platform;
  if (dirname(abs) === abs) return `${abs} is a whole drive.`;
  if (plainInside(home, abs)) return `${abs} holds your whole home folder.`;
  if (plainInside(ppmDir, abs) || plainInside(abs, ppmDir) || isCredentialPath(abs)) return `${abs} holds PPM's own data and credentials.`;
  const first = firstSegmentBelow(abs, home);
  if (first && isHomeStateEntry(first, platform)) {
    return `${abs} is inside ${first} in your home folder, where applications keep their own data and logins.`;
  }
  const roots = opts.privateRoots ?? assistantPrivateRoots(home, process.env, platform);
  const private_ = roots.find((root) => isInside(abs, root) || isInside(root, abs));
  if (private_) return `${abs} ${isInside(abs, private_) ? "is inside" : "holds"} ${private_}, which keeps logins or keys.`;
  return null;
}
