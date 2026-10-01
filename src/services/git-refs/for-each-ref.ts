/**
 * Every checkout target — local branches, remote-tracking branches and tags —
 * out of a single `git for-each-ref`, with the commit each one points at.
 *
 * The format string is built from the field list rather than written out,
 * because the parser reads fields *positionally*: a field added to one and not
 * the other shifts everything after it, and git answers just as happily either
 * way — the picker would simply show a date where the author belongs, with
 * nothing failing.
 *
 * Six of the twelve fields are the `*`-dereferenced twins of six others, and
 * they are what makes an **annotated** tag readable. `refs/tags/v1` resolves to
 * the tag *object*, not to a commit: its `objectname` is the tag's own hash,
 * it has a tagger rather than an author (so `%(authorname)` and
 * `%(committerdate)` come back empty) and its `contents:subject` is the tag
 * message. A lightweight tag has no such object and leaves every `*` field
 * empty — which is why each pair is resolved as "dereferenced when non-empty,
 * else plain" rather than by asking what kind of ref it is.
 */
import type { GitRef } from "../../types/git.ts";

const FIELDS = [
  "refname",
  "objectname",
  "*objectname",
  "HEAD",
  "upstream:short",
  "upstream:track",
  "authorname",
  "*authorname",
  "committerdate:iso-strict",
  "*committerdate:iso-strict",
  "contents:subject",
  "*contents:subject",
] as const;

/** NUL between fields, newline between records: no ref name or subject may contain either. */
export const FOR_EACH_REF_FORMAT = FIELDS.map((f) => `%(${f})`).join("%00");

export const FOR_EACH_REF_ARGS = [
  "for-each-ref",
  `--format=${FOR_EACH_REF_FORMAT}`,
  "refs/heads",
  "refs/remotes",
  "refs/tags",
];

const PREFIX: Record<GitRef["type"], string> = {
  branch: "refs/heads/",
  remote: "refs/remotes/",
  tag: "refs/tags/",
};

/**
 * `%(upstream:track)` as git writes it: `[ahead 1, behind 26]`, either half on
 * its own, `[gone]` when the remote branch was deleted, or empty when the
 * branch has no upstream at all.
 */
export function parseUpstreamTrack(track: string): Pick<GitRef, "ahead" | "behind" | "gone"> {
  if (track.includes("gone")) return { ahead: 0, behind: 0, gone: true };
  const ahead = /ahead (\d+)/.exec(track);
  const behind = /behind (\d+)/.exec(track);
  return {
    ahead: ahead ? Number(ahead[1]) : 0,
    behind: behind ? Number(behind[1]) : 0,
    gone: false,
  };
}

function refType(refName: string): GitRef["type"] | null {
  for (const [type, prefix] of Object.entries(PREFIX)) {
    if (refName.startsWith(prefix)) return type as GitRef["type"];
  }
  return null;
}

/** Newest commit first. Compared as instants, never as strings: `iso-strict` carries the author's own offset. */
function newestFirst(a: GitRef, b: GitRef): number {
  const at = Date.parse(a.date);
  const bt = Date.parse(b.date);
  if (Number.isNaN(at) || Number.isNaN(bt)) return a.name.localeCompare(b.name);
  return bt - at;
}

export function parseForEachRef(stdout: string): GitRef[] {
  const refs: GitRef[] = [];

  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const f = line.split("\0");
    // A short record means a field carried a newline after all. Skipping it
    // loses one row; reading it would silently shift every field of that row.
    if (f.length < FIELDS.length) continue;

    const refName = f[0]!;
    const type = refType(refName);
    if (!type) continue;
    // `origin/HEAD` is a symbolic pointer at another row of this same list.
    if (type === "remote" && refName.endsWith("/HEAD")) continue;

    const hash = f[2] || f[1]!;
    refs.push({
      refName,
      name: refName.slice(PREFIX[type].length),
      type,
      current: f[3] === "*",
      hash,
      shortHash: hash.slice(0, 7),
      subject: f[11] || f[10]!,
      author: f[7] || f[6]!,
      date: f[9] || f[8]!,
      upstream: f[4] || null,
      ...parseUpstreamTrack(f[5]!),
    });
  }

  return refs.sort(newestFirst);
}
