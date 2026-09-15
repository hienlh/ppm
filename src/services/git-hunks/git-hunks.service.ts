/**
 * Staging, unstaging and discarding at hunk / line granularity.
 *
 * Each operation is a patch fed to `git apply` on stdin. `simple-git` has no
 * stdin door, so these spawn git directly.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiffHunk } from "./unified-diff.ts";
import {
  buildPatch, hunkFingerprint, parseUnifiedDiff, resolveRequestedHunks, selectionFromRequest,
} from "./unified-diff.ts";

export type HunkScope = "worktree" | "index";

export interface HunkRequest {
  /** Where the hunk sat in the list the client was given. A hint, not the key. */
  hunk: number;
  /**
   * `hunkFingerprint` of the hunk the user actually ticked. This is what the
   * selection is resolved by, so a file that moved on cannot be silently staged
   * from a different diff than the one on screen.
   */
  id: string;
  /** Line indexes within the hunk; omitted means the whole hunk. */
  lines?: number[];
}

/** A hunk as the browser receives it: UTF-8 text plus its content address. */
export type ListedHunk = DiffHunk & { id: string };

export interface FileHunks {
  filePath: string;
  scope: HunkScope;
  hunks: ListedHunk[];
  binary: boolean;
}

interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Spawn git and hand back its output byte-for-byte.
 *
 * Two things here are load-bearing and neither is visible in review.
 *
 * Chunks are collected as `Buffer` and decoded **once**. Decoding each chunk as
 * it arrives (`stdout += c.toString()`) splits any multi-byte sequence that
 * straddles a chunk boundary into two invalid halves, which become U+FFFD — and
 * because a patch built from that text still *applies*, the corruption lands in
 * the index with no error anywhere. Measured on a 2 MB all-Japanese diff: 43
 * mangled lines.
 *
 * The decode is **latin1**, not utf8, so it is a lossless byte round-trip: the
 * patch written back to `git apply` is the bytes git gave us, whatever the
 * file's encoding actually is (a Latin-1 file could not be hunk-staged at all
 * before). Everything the parser looks at — `@@`, `+`, `-`, `\` — is ASCII and
 * reads the same either way. Only text leaving for the browser is turned back
 * into UTF-8, by `toDisplay` below.
 */
function runGit(
  projectPath: string,
  args: string[],
  options: { stdin?: Buffer; env?: Record<string, string> } = {},
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: projectPath,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...options.env },
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => { stdout.push(c); });
    child.stderr.on("data", (c: Buffer) => { stderr.push(c); });
    child.on("error", reject);
    child.on("close", (code) => resolve({
      stdout: Buffer.concat(stdout).toString("latin1"),
      // stderr only ever becomes a message for a human, so it is decoded the
      // way a human expects to read it.
      stderr: Buffer.concat(stderr).toString("utf8"),
      exitCode: code ?? 0,
    }));

    if (options.stdin !== undefined) {
      child.stdin.end(options.stdin);
    } else {
      child.stdin.end();
    }
  });
}

/** Undo `runGit`'s latin1 decode, for text on its way to the browser. */
function toDisplay(text: string): string {
  return Buffer.from(text, "latin1").toString("utf8");
}

/**
 * Reject a path that is absolute, escapes the repository, or could be read as
 * an option. Callers pass paths straight from the browser.
 */
function assertSafeFilePath(filePath: string): string {
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

class GitHunksService {
  /** Is the file untracked? Hunk staging needs it in the index first. */
  private async isUntracked(projectPath: string, filePath: string): Promise<boolean> {
    const res = await runGit(projectPath, ["ls-files", "--error-unmatch", "--", filePath]);
    return res.exitCode !== 0;
  }

  /**
   * An index git may write to, for a file it has never seen.
   *
   * A `git diff` needs something to compare against, which for an untracked
   * file is what `git add -N` provides. That is a write, and every caller here
   * is describing a file rather than changing one: doing it to the user's index
   * turns `?? file` into `A file` behind their back, on nothing more than
   * opening a dialog, and the exit code went unread so a failure showed up as
   * "no changes" instead. It goes into a throwaway index instead — git reads the
   * same config and the same `.gitattributes`, normalises line endings the same
   * way and produces the same bytes, while the real index is never opened for
   * writing. `git apply --cached` needs no entry of its own to add a new file,
   * so staging still lands in the real index.
   */
  private async scratchIndexFor(projectPath: string, filePath: string): Promise<string | null> {
    if (!await this.isUntracked(projectPath, filePath)) return null;
    const dir = await mkdtemp(join(tmpdir(), "ppm-hunk-index-"));
    const env = { GIT_INDEX_FILE: join(dir, "index") };
    const added = await runGit(projectPath, ["add", "-N", "--", filePath], { env });
    if (added.exitCode !== 0) {
      await rm(dir, { recursive: true, force: true });
      throw new Error(
        added.stderr.trim() || `git could not read "${filePath}" (exit ${added.exitCode}).`,
      );
    }
    return dir;
  }

  /**
   * `--no-renames` is not a formatting preference.
   *
   * With rename detection on, a staged `git mv` makes `git diff --cached` emit a
   * *rename patch*, and `git apply --cached --reverse` on one of those rewrites
   * index entries instead of lines: unstaging a single hunk left `D a.txt`
   * staged and `b.txt` untracked, one commit away from losing the file's
   * history. Forcing the content form keeps every patch here a patch about
   * lines in one path.
   */
  private async rawDiff(projectPath: string, filePath: string, scope: HunkScope): Promise<string> {
    const scratch = scope === "worktree" ? await this.scratchIndexFor(projectPath, filePath) : null;
    try {
      const args = ["diff", "--no-color", "--no-ext-diff", "--no-renames"];
      if (scope === "index") args.push("--cached");
      args.push("--", filePath);
      const res = await runGit(projectPath, args, {
        env: scratch ? { GIT_INDEX_FILE: join(scratch, "index") } : undefined,
      });
      if (res.exitCode !== 0) {
        throw new Error(res.stderr.trim() || `git diff exited with ${res.exitCode}`);
      }
      // Belt and braces: a future flag or a repository config that reintroduces
      // rename headers must fail loudly rather than reach `git apply --reverse`.
      if (/^rename (from|to) /m.test(res.stdout)) {
        throw new Error("This file was renamed — stage or unstage it whole rather than by hunk.");
      }
      return res.stdout;
    } finally {
      if (scratch) await rm(scratch, { recursive: true, force: true });
    }
  }

  /**
   * The hunks the UI shows, each carrying the content address it must send back.
   *
   * Fingerprints are taken from the byte-exact text and the *text* is then
   * converted for display, so what the client echoes identifies the bytes
   * rather than a lossy rendering of them.
   */
  async getHunks(projectPath: string, filePath: string, scope: HunkScope): Promise<FileHunks> {
    assertSafeFilePath(filePath);
    const parsed = parseUnifiedDiff(await this.rawDiff(projectPath, filePath, scope));
    const hunks: ListedHunk[] = parsed.hunks.map((hunk) => ({
      ...hunk,
      id: hunkFingerprint(hunk),
      heading: toDisplay(hunk.heading),
      lines: hunk.lines.map((line) => ({ ...line, text: toDisplay(line.text) })),
    }));
    return { filePath, scope, hunks, binary: parsed.binary };
  }

  private async applySelection(
    projectPath: string,
    filePath: string,
    scope: HunkScope,
    requested: HunkRequest[],
    apply: { cached: boolean; reverse: boolean },
  ): Promise<void> {
    assertSafeFilePath(filePath);
    if (requested.length === 0) throw new Error("No hunks were selected.");

    const parsed = parseUnifiedDiff(await this.rawDiff(projectPath, filePath, scope));
    if (parsed.binary) throw new Error("A binary file cannot be staged by hunk — stage the whole file.");
    if (parsed.hunks.length === 0) throw new Error("This file has no changes to apply.");

    // The client's indexes describe the diff it was *shown*; this diff was read
    // again just now. Resolving by content is what makes the two the same list
    // — or refuses. `git apply` cannot be the guard here, because the patch is
    // built from this fresh parse and therefore always applies cleanly.
    const selection = selectionFromRequest(parsed, resolveRequestedHunks(parsed, requested));
    const patch = buildPatch(parsed, selection, { reverse: apply.reverse });
    if (!patch) throw new Error("The selection contains no actual change.");

    // Default three lines of context, no `--unidiff-zero`.
    const args = ["apply"];
    if (apply.cached) args.push("--cached");
    if (apply.reverse) args.push("--reverse");
    args.push("-");

    const res = await runGit(projectPath, args, { stdin: Buffer.from(patch, "latin1") });
    if (res.exitCode !== 0) {
      throw new Error(
        res.stderr.trim() ||
        `git could not apply the patch (exit ${res.exitCode}).`,
      );
    }
  }

  /** Move the selected worktree changes into the index. */
  async stage(projectPath: string, filePath: string, hunks: HunkRequest[]): Promise<void> {
    await this.applySelection(projectPath, filePath, "worktree", hunks, { cached: true, reverse: false });
  }

  /** Take the selected staged changes back out of the index. */
  async unstage(projectPath: string, filePath: string, hunks: HunkRequest[]): Promise<void> {
    await this.applySelection(projectPath, filePath, "index", hunks, { cached: true, reverse: true });
  }

  /** Throw away the selected worktree changes. Not recoverable. */
  async discard(projectPath: string, filePath: string, hunks: HunkRequest[]): Promise<void> {
    await this.applySelection(projectPath, filePath, "worktree", hunks, { cached: false, reverse: true });
  }
}

export const gitHunksService = new GitHunksService();
