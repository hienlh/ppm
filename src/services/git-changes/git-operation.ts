/**
 * Which multi-step command, if any, stopped part way in this repository.
 *
 * git keeps no single "state" — each command leaves its own marker in the git
 * directory, so this reads them in the order git itself checks: a rebase
 * first (a conflicting pick inside one also writes the files a cherry-pick
 * would), then a merge, a cherry-pick, a revert.
 *
 * The directory must be the one `git rev-parse --absolute-git-dir` names: in a
 * linked worktree that is `.git/worktrees/<name>`, where these markers live,
 * not the shared `.git`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GitOperation } from "../../shared/git-changes.ts";

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

function readInt(path: string): number | undefined {
  const text = readText(path);
  if (text === null) return undefined;
  const n = Number.parseInt(text, 10);
  return Number.isFinite(n) ? n : undefined;
}

function shortRef(text: string | null): string | undefined {
  if (!text) return undefined;
  return text.replace(/^refs\/heads\//, "");
}

function shortId(text: string | null): string | undefined {
  const first = text?.split("\n")[0]?.trim();
  return first ? first.slice(0, 7) : undefined;
}

/** What `MERGE_MSG`'s first line says is being merged: "Merge branch 'main' into x" → main. */
export function mergeSubject(message: string | null): string | undefined {
  const first = message?.split("\n")[0] ?? "";
  const m = /^Merge (?:remote-tracking branch|branch|tag|commit) '([^']+)'/.exec(first);
  return m?.[1];
}

export function readGitOperation(gitDir: string): GitOperation | null {
  const rebaseMerge = join(gitDir, "rebase-merge");
  if (existsSync(rebaseMerge)) {
    return {
      kind: "rebase",
      name: shortRef(readText(join(rebaseMerge, "head-name"))),
      step: readInt(join(rebaseMerge, "msgnum")),
      total: readInt(join(rebaseMerge, "end")),
    };
  }

  const rebaseApply = join(gitDir, "rebase-apply");
  if (existsSync(rebaseApply)) {
    return {
      kind: existsSync(join(rebaseApply, "applying")) ? "am" : "rebase",
      name: shortRef(readText(join(rebaseApply, "head-name"))),
      step: readInt(join(rebaseApply, "next")),
      total: readInt(join(rebaseApply, "last")),
    };
  }

  const mergeHead = readText(join(gitDir, "MERGE_HEAD"));
  if (mergeHead !== null) {
    return {
      kind: "merge",
      head: shortId(mergeHead),
      name: mergeSubject(readText(join(gitDir, "MERGE_MSG"))),
    };
  }

  const pick = readText(join(gitDir, "CHERRY_PICK_HEAD"));
  if (pick !== null) return { kind: "cherry-pick", head: shortId(pick) };

  const revert = readText(join(gitDir, "REVERT_HEAD"));
  if (revert !== null) return { kind: "revert", head: shortId(revert) };

  return null;
}
