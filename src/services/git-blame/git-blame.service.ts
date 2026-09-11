/**
 * `git blame` for the editor's inline annotation.
 *
 * One call blames the whole file — running it per line would be a process per
 * cursor move. The result is small (a line table plus one record per distinct
 * commit) and the frontend indexes into it as the cursor moves.
 */
import simpleGit from "simple-git";
import { parseBlamePorcelain } from "./blame-porcelain.ts";
import { lineChangeAt, parseShow } from "./commit-line-diff.ts";
import type { BlameLineDetail, BlameResult } from "../../shared/blame.ts";

/**
 * Reject a path that is absolute, escapes the repository, or could be read as
 * an option. Callers pass paths straight from the browser.
 *
 * Deliberately no `node:path` normalisation: on Windows that would rewrite the
 * separators git expects, and the check is about the string git receives.
 */
export function assertSafeFilePath(filePath: string): string {
  if (!filePath || filePath.startsWith("-") || filePath.startsWith("/") || /[\x00-\x1f\x7f]/.test(filePath)) {
    throw new Error(`Invalid file path: "${filePath}"`);
  }
  let depth = 0;
  for (const segment of filePath.split(/[\\/]+/)) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      depth--;
      if (depth < 0) throw new Error(`File path escapes the repository: "${filePath}"`);
      continue;
    }
    depth++;
  }
  return filePath;
}

/**
 * Reject a revision that could be read as an option or as a range.
 *
 * A revision reaches git as its own argv word, so shell metacharacters are not
 * the hazard here — the two that actually change what the command means are a
 * leading dash (`--reverse`) and the range syntaxes (`a..b`).
 *
 * `~` and `^` stay allowed on purpose: `HEAD~1` and `main^` are exactly the
 * revisions the diff viewer asks for. The rest of the character class is what
 * `git check-ref-format` forbids in a refname anyway.
 */
export function assertSafeRev(rev: string): string {
  if (
    !rev ||
    rev.startsWith("-") ||
    rev.includes("..") ||
    /[\x00-\x1f\x7f:?*[\]\\ ]/.test(rev)
  ) {
    throw new Error(`Invalid revision: "${rev}"`);
  }
  return rev;
}

/**
 * Reject anything that is not a commit hash. Stricter than `assertSafeRev` on
 * purpose: this value is the one argument to `git show`, and the hover only ever
 * has a hash from a blame it already ran, so `HEAD~1` and friends are not
 * requests to honour — they are a sign the caller is not the hover.
 */
export function assertCommitHash(hash: string): string {
  if (!/^[0-9a-f]{7,40}$/.test(hash)) throw new Error(`Invalid commit hash: "${hash}"`);
  return hash;
}

class GitBlameService {
  /**
   * Blame every line of `filePath`, in the working tree or as it stood at `rev`.
   *
   * `rev` is what makes blame work inside the diff viewer: each side of a diff
   * is the file at a different revision, so blaming the working tree for the
   * left-hand pane would name the wrong commits.
   *
   * Returns null when there is nothing to blame — the file is untracked, or did
   * not exist at that revision. Both are ordinary states the UI shows as "no
   * annotation" rather than an error.
   */
  async blameFile(projectPath: string, filePath: string, rev?: string): Promise<BlameResult | null> {
    assertSafeFilePath(filePath);
    const git = simpleGit(projectPath);
    // `-w` ignores whitespace-only changes, so a reformat does not claim every
    // line. `--` separates the path from the options for good.
    const args = ["blame", "--porcelain", "-w"];
    if (rev) args.push(assertSafeRev(rev));
    args.push("--", filePath);

    try {
      return parseBlamePorcelain(await git.raw(args));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (/no such path|does not have|is outside repository|no such file/i.test(message)) return null;
      throw e;
    }
  }

  /**
   * The commit message and the one-line diff behind a blamed line, for the
   * editor's hover.
   *
   * `filePath` must be the path the file had *at that commit* — after a rename
   * the current path did not exist there, and `git show` would report no diff
   * at all rather than an error. `git blame --porcelain` supplies it as
   * `filename`, which is why the caller passes it rather than the open file's
   * path.
   *
   * `origLine` is likewise the line number at that commit, not now.
   *
   * Returns null when there is nothing to show — an unknown hash, or a path git
   * has never heard of. A commit with no diff for this line is *not* null: the
   * message is still worth showing, so `removed` and `added` come back empty.
   * That is the ordinary case for a merge commit, which shows no diff.
   */
  async lineDetail(
    projectPath: string,
    hash: string,
    filePath: string,
    origLine: number,
  ): Promise<BlameLineDetail | null> {
    assertCommitHash(hash);
    assertSafeFilePath(filePath);
    const git = simpleGit(projectPath);
    const args = [
      "show",
      // NUL-separated fields ahead of the diff. See `commit-line-diff.ts`.
      "--format=%H%x00%an%x00%ae%x00%at%x00%B%x00",
      "--unified=0",
      hash,
      "--",
      filePath,
    ];

    let raw: string;
    try {
      raw = await git.raw(args);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // git's wording varies by which lookup failed: a hash it cannot resolve is
      // "bad revision", one that resolves to nothing is "bad object", and a path
      // that commit never had is "exists on disk, but not in". All three mean the
      // same thing here — no hover.
      if (/bad revision|unknown revision|bad object|not a valid object name|no such path|does not exist|but not in/i.test(message)) {
        return null;
      }
      throw e;
    }

    const fields = parseShow(raw);
    if (!fields) return null;
    const change = lineChangeAt(fields.diff, origLine);
    return {
      hash: fields.hash,
      author: fields.author,
      authorMail: fields.authorMail,
      authorTime: fields.authorTime,
      message: fields.message,
      removed: change?.removed ?? [],
      added: change?.added ?? [],
    };
  }
}

export const gitBlameService = new GitBlameService();
