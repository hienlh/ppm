/**
 * `git log --format=%H --shortstat` into a hash → lines-changed map.
 *
 * A second pass rather than `--shortstat` on the main log: adding it there costs
 * git a diff per commit (~100ms for 300 commits on a 2k-commit repository, and
 * far more on a large one) and that cost would land *before* the graph could be
 * drawn at all. This runs after the commits have already been sent, so the
 * numbers fill in a moment later and nothing waits for them.
 *
 * A merge commit produces no diffstat at all, which is git's default and not an
 * error — it is simply absent from the map, and the column stays blank for it.
 */

export interface CommitStat {
  files: number;
  insertions: number;
  deletions: number;
}

/** " 3 files changed, 12 insertions(+), 4 deletions(-)" — any of the three clauses may be missing. */
const SHORTSTAT = /^\s*(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/;
const FULL_HASH = /^[0-9a-f]{40}$/;

export function parseShortstat(stdout: string): Record<string, CommitStat> {
  const stats: Record<string, CommitStat> = {};
  let hash: string | null = null;

  for (const line of stdout.split("\n")) {
    if (FULL_HASH.test(line.trim())) {
      hash = line.trim();
      continue;
    }
    const match = SHORTSTAT.exec(line);
    // The stat follows the hash it belongs to, so a stat with no hash before it
    // is not ours — better to drop it than to attach it to the wrong commit.
    if (!match || !hash) continue;
    stats[hash] = {
      files: Number(match[1]),
      insertions: match[2] ? Number(match[2]) : 0,
      deletions: match[3] ? Number(match[3]) : 0,
    };
    hash = null;
  }
  return stats;
}
