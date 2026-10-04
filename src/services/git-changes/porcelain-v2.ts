/**
 * `git status --porcelain=v2 -z --branch` parsed.
 *
 * Version 2 rather than the v1 the rest of PPM reads, because it is the one
 * that says outright which entries are unmerged (`u`), which are renames (`2`,
 * with the source as the next NUL-terminated field) and which are submodules,
 * and that carries the upstream and ahead/behind in its headers. With `-z`
 * paths are never quoted. Input is latin1-decoded, so paths stay byte strings.
 */

export interface PorcelainBranch {
  oid: string | null;
  /** Null when HEAD is detached. */
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  /**
   * git printed ahead/behind. It does not when the upstream is configured but
   * gone from the remote, which is not the same as being level with it.
   */
  compared: boolean;
}

export type PorcelainKind = "ordinary" | "renamed" | "unmerged" | "untracked" | "ignored";

export interface PorcelainEntry {
  kind: PorcelainKind;
  /** `.` for unchanged; `?` for untracked; `!` for ignored. */
  x: string;
  y: string;
  path: string;
  /** Rename or copy source. */
  origPath?: string;
  /** `N...` for a regular path, `S<c><m><u>` for a submodule. */
  sub: string;
  /** Modes as git listed them (HEAD, index, worktree; or stages 1–3 then worktree). */
  modes: string[];
}

export interface PorcelainStatus {
  branch: PorcelainBranch;
  entries: PorcelainEntry[];
}

/** Split off the first `count` space-separated fields; the rest is the path. */
function fields(token: string, count: number): { parts: string[]; rest: string } | null {
  const parts: string[] = [];
  let from = 0;
  for (let i = 0; i < count; i++) {
    const space = token.indexOf(" ", from);
    if (space === -1) return null;
    parts.push(token.slice(from, space));
    from = space + 1;
  }
  return { parts, rest: token.slice(from) };
}

export function parsePorcelainV2(output: string): PorcelainStatus {
  const branch: PorcelainBranch = { oid: null, head: null, upstream: null, ahead: 0, behind: 0, compared: false };
  const entries: PorcelainEntry[] = [];
  const tokens = output.split("\0");

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (!token) continue;

    if (token.startsWith("# ")) {
      const [key, ...value] = token.slice(2).split(" ");
      const text = value.join(" ");
      if (key === "branch.oid") branch.oid = text === "(initial)" ? null : text;
      else if (key === "branch.head") branch.head = text === "(detached)" ? null : text;
      else if (key === "branch.upstream") branch.upstream = text;
      else if (key === "branch.ab") {
        const m = /^\+(\d+) -(\d+)$/.exec(text);
        if (m) { branch.ahead = Number(m[1]); branch.behind = Number(m[2]); branch.compared = true; }
      }
      continue;
    }

    const type = token[0];
    if (type === "?" || type === "!") {
      entries.push({
        kind: type === "?" ? "untracked" : "ignored",
        x: type, y: type, path: token.slice(2), sub: "N...", modes: [],
      });
      continue;
    }

    if (type === "1") {
      const f = fields(token, 8);
      if (!f) continue;
      const [, xy, sub, mH, mI, mW] = f.parts as [string, string, string, string, string, string];
      entries.push({ kind: "ordinary", x: xy[0]!, y: xy[1]!, path: f.rest, sub, modes: [mH, mI, mW] });
      continue;
    }

    if (type === "2") {
      const f = fields(token, 9);
      if (!f) continue;
      const [, xy, sub, mH, mI, mW] = f.parts as [string, string, string, string, string, string];
      // The source path is the next NUL-terminated field, not part of this one.
      const origPath = tokens[++i] ?? "";
      entries.push({ kind: "renamed", x: xy[0]!, y: xy[1]!, path: f.rest, origPath, sub, modes: [mH, mI, mW] });
      continue;
    }

    if (type === "u") {
      const f = fields(token, 10);
      if (!f) continue;
      const [, xy, sub, m1, m2, m3, mW] = f.parts as [string, string, string, string, string, string, string];
      entries.push({ kind: "unmerged", x: xy[0]!, y: xy[1]!, path: f.rest, sub, modes: [m1, m2, m3, mW] });
    }
  }

  return { branch, entries };
}
