/**
 * Staging, unstaging and discarding at hunk / line granularity.
 *
 * Each operation is a patch fed to `git apply` on stdin. `simple-git` has no
 * stdin door, so these spawn git directly.
 */
import { spawn } from "node:child_process";
import type { DiffHunk } from "./unified-diff.ts";
import { buildPatch, parseUnifiedDiff, selectionFromRequest } from "./unified-diff.ts";

export type HunkScope = "worktree" | "index";

export interface HunkRequest {
  hunk: number;
  /** Line indexes within the hunk; omitted means the whole hunk. */
  lines?: number[];
}

export interface FileHunks {
  filePath: string;
  scope: HunkScope;
  hunks: DiffHunk[];
  binary: boolean;
}

interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runGit(projectPath: string, args: string[], stdin?: string): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: projectPath,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c.toString(); });
    child.stderr.on("data", (c) => { stderr += c.toString(); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 0 }));

    if (stdin !== undefined) {
      child.stdin.end(stdin);
    } else {
      child.stdin.end();
    }
  });
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
   * `git add -N` records the file in the index with empty content, so a normal
   * `git diff` describes the whole file as additions and the usual patch path
   * works. Without it an untracked file has nothing to diff against.
   */
  private async ensureIntentToAdd(projectPath: string, filePath: string): Promise<void> {
    if (await this.isUntracked(projectPath, filePath)) {
      await runGit(projectPath, ["add", "-N", "--", filePath]);
    }
  }

  private async rawDiff(projectPath: string, filePath: string, scope: HunkScope): Promise<string> {
    const args = ["diff", "--no-color", "--no-ext-diff"];
    if (scope === "index") args.push("--cached");
    args.push("--", filePath);
    const res = await runGit(projectPath, args);
    if (res.exitCode !== 0) {
      throw new Error(res.stderr.trim() || `git diff exited with ${res.exitCode}`);
    }
    return res.stdout;
  }

  /** The hunks the UI shows and later refers to by index. */
  async getHunks(projectPath: string, filePath: string, scope: HunkScope): Promise<FileHunks> {
    assertSafeFilePath(filePath);
    if (scope === "worktree") await this.ensureIntentToAdd(projectPath, filePath);
    const parsed = parseUnifiedDiff(await this.rawDiff(projectPath, filePath, scope));
    return { filePath, scope, hunks: parsed.hunks, binary: parsed.binary };
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

    const selection = selectionFromRequest(parsed, requested);
    const patch = buildPatch(parsed, selection, { reverse: apply.reverse });
    if (!patch) throw new Error("The selection contains no actual change.");

    // No `--unidiff-zero`: these patches keep git's default three lines of
    // context, and that flag would switch off the very check that catches a
    // patch built against a stale diff.
    const args = ["apply"];
    if (apply.cached) args.push("--cached");
    if (apply.reverse) args.push("--reverse");
    args.push("-");

    const res = await runGit(projectPath, args, patch);
    if (res.exitCode !== 0) {
      // Nearly always means the file moved on since the hunks were listed.
      throw new Error(
        res.stderr.trim() ||
        "git could not apply the patch — the file changed since these hunks were listed. Reload and try again.",
      );
    }
  }

  /** Move the selected worktree changes into the index. */
  async stage(projectPath: string, filePath: string, hunks: HunkRequest[]): Promise<void> {
    await this.ensureIntentToAdd(projectPath, filePath);
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
