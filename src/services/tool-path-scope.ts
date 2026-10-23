import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path, { basename, dirname, isAbsolute, join, resolve } from "node:path";

type PlatformPath = typeof path.posix;

/**
 * Path checks shared by the tool permission policies (a design session's, a session an
 * extension bound). Everything here fails closed: a path that cannot be resolved is
 * answered with null or "outside", never with a guess.
 */

/** `~` is expanded the way a shell would, so `~/.ssh` is judged as the home directory it
 *  names rather than as a folder called `~` inside the project. */
export function expandHome(target: string): string {
  if (target === "~") return homedir();
  if (target.startsWith("~/") || target.startsWith("~\\")) return join(homedir(), target.slice(2));
  return target;
}

/**
 * True when a Glob pattern could enumerate outside the directory it is run in. Globbers
 * expand braces before they walk (`{a,..}/**` is also `../**`), so every expansion is judged,
 * and a `..` anywhere is refused outright — the price is a rare `a..b` name or `{1..3}` range.
 */
export function patternLeavesRoot(pattern: string): boolean {
  if (pattern.includes("..")) return true;
  const variants = expandBraces(pattern);
  if (!variants) return true;
  return variants.some((p) => isAbsolute(p) || /^[a-zA-Z]:/.test(p) || p.startsWith("~") || p.split(/[\\/]/).includes(".."));
}

/** The first balanced `{…}` at or after `from`, with its top-level alternatives. */
function firstBraceGroup(text: string, from: number): { open: number; close: number; alternatives: string[] } | null {
  for (let open = text.indexOf("{", from); open !== -1; open = text.indexOf("{", open + 1)) {
    let depth = 0;
    let start = open + 1;
    const alternatives: string[] = [];
    for (let i = open; i < text.length; i++) {
      const c = text[i];
      if (c === "{") depth++;
      else if (c === "," && depth === 1) {
        alternatives.push(text.slice(start, i));
        start = i + 1;
      } else if (c === "}" && --depth === 0) {
        alternatives.push(text.slice(start, i));
        return { open, close: i, alternatives };
      }
    }
  }
  return null;
}

/**
 * Every pattern a brace expression stands for (`a/{b,c}` is `a/b` and `a/c`), nested braces
 * included; an unbalanced brace is kept as a literal character, as globbers keep it. Null
 * once there would be more than `limit` patterns, which the caller treats as leaving.
 */
export function expandBraces(pattern: string, limit = 256): string[] | null {
  const out: string[] = [];
  const pending = [{ text: pattern, from: 0 }];
  while (pending.length > 0) {
    const { text, from } = pending.pop()!;
    const group = firstBraceGroup(text, from);
    if (!group) {
      out.push(text);
    } else {
      const head = text.slice(0, group.open);
      const tail = text.slice(group.close + 1);
      // Rescanned from the group's position: an alternative may hold braces of its own.
      for (const alternative of group.alternatives) pending.push({ text: head + alternative + tail, from: group.open });
    }
    if (out.length + pending.length > limit) return null;
  }
  return out;
}

/**
 * True when a Windows path names an NTFS stream (`name:stream`, `name::$DATA`): a `:`
 * anywhere past its root. Writing `secrets.json::$DATA` creates `secrets.json`, so a name a
 * protected glob would refuse could otherwise be reached through its stream syntax.
 */
export function namesAlternateStream(target: string, p: PlatformPath = path.win32): boolean {
  return target.slice(p.parse(target).root.length).includes(":");
}

/**
 * Realpath of the path, or of its nearest existing ancestor with the missing tail
 * re-appended — a Write usually targets a file that does not exist yet, and its parent
 * directories may not either. Null when nothing along the chain resolves.
 */
export function canonicalPath(target: string): string | null {
  const tail: string[] = [];
  let current = resolve(target);
  for (;;) {
    try {
      const real = realpathSync.native(current);
      return tail.length ? join(real, ...tail.reverse()) : real;
    } catch {
      // Something is there but cannot be resolved — typically a dangling symlink, which
      // a Write would follow to wherever it points. Only a truly absent entry may be
      // replaced by its parent.
      if (entryExists(current)) return null;
      const parent = dirname(current);
      if (parent === current) return null;
      tail.push(basename(current));
      current = parent;
    }
  }
}

export function entryExists(target: string): boolean {
  try {
    lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

const caseFolds = (platform: NodeJS.Platform) => platform === "win32" || platform === "darwin";

/**
 * `isInside` for a given path flavour, so the Windows rules can be checked from any host.
 * `relative()` answers an absolute path for a target on another drive (`D:\x` from `C:\r`),
 * which is why an absolute result means "outside" rather than being read as a subpath.
 */
export function isInsideWith(p: PlatformPath, caseFold: boolean): (target: string, root: string) => boolean {
  return (target, root) => {
    const a = caseFold ? target.toLowerCase() : target;
    const b = caseFold ? root.toLowerCase() : root;
    const rel = p.relative(b, a);
    if (rel === "") return true;
    return !p.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${p.sep}`);
  };
}

/** True when the target is the root or anything below it, on this host's path rules. */
export const isInside = isInsideWith(path, caseFolds(process.platform));

/** The target's path below the root, `/`-separated; call only once `isInside` said yes. */
export function relativeInside(target: string, root: string): string {
  return path.relative(root, target).split(path.sep).join("/");
}

/**
 * One glob pattern as a regular expression over a `/`-separated path: `**` spans any number
 * of segments (none included), `*` and `?` stay inside one segment, and a dot is an ordinary
 * character (so `*` matches `.env`).
 */
function globToRegExp(pattern: string, caseFold: boolean): RegExp {
  let source = "";
  const parts = pattern.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").split("/");
  parts.forEach((part, i) => {
    const last = i === parts.length - 1;
    if (part === "**") {
      source += last ? ".*" : "(?:[^/]*/)*";
      return;
    }
    source += part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
    if (!last) source += "/";
  });
  return new RegExp(`^${source}$`, caseFold ? "i" : "");
}

/**
 * True when the relative path, or any trailing part of it that starts at a segment, matches
 * one of the patterns. Unanchored on purpose: `package.json` and `.git/**` are protected in
 * every checkout below a root, not only at its top.
 */
export function matchesProtectedPath(relPath: string, patterns: readonly string[], caseFold = caseFolds(process.platform)): boolean {
  const segments = relPath.split("/").filter(Boolean);
  const regexps = patterns.filter((p) => p.trim()).map((p) => globToRegExp(p.trim(), caseFold));
  for (let i = 0; i < segments.length; i++) {
    const suffix = segments.slice(i).join("/");
    if (regexps.some((re) => re.test(suffix))) return true;
  }
  return false;
}
