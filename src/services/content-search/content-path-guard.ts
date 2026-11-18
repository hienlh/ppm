/**
 * The path check search and replace share, so a search never lists — path or line — a file a
 * replace would refuse to touch: it must sit inside the project, and it may not be a credential
 * path (`isCredentialPath`: the PPM directory, `~/.cloudflared`, the database snapshots). Each
 * caller asks for the path as named *and* for its real path, so a link cannot carry either past.
 * Runs in the search host, so it imports nothing that reaches config or the database.
 */
import { isAbsolute, relative, resolve } from "node:path";
import { isCredentialPath } from "../fs-credential-path-guard.ts";
import { realPathOrSelfSync } from "../fs-ops/fs-real-path.ts";

/** The path of `child` inside `root`, or null when it is the root itself or outside it. */
export function inside(root: string, child: string): string | null {
  const rel = relative(root, child);
  if (rel === "" || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) return null;
  return rel;
}

/** Why neither search nor replace may use `path` under `root`, or null when both may. */
export function refusedPathReason(root: string, path: string): "outside the project" | "access denied" | null {
  if (inside(root, path) === null) return "outside the project";
  if (isCredentialPath(path)) return "access denied";
  return null;
}

/**
 * A filter over the files a search reports (project-relative), true for those it may list.
 * One answer per file, since a file reports many matches.
 */
export function searchablePaths(projectPath: string): (file: string) => boolean {
  const root = resolve(projectPath);
  const realRoot = realPathOrSelfSync(root);
  const seen = new Map<string, boolean>();
  return (file) => {
    let ok = seen.get(file);
    if (ok === undefined) {
      const path = resolve(root, file);
      ok = refusedPathReason(root, path) === null && refusedPathReason(realRoot, realPathOrSelfSync(path)) === null;
      seen.set(file, ok);
    }
    return ok;
  };
}
