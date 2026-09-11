/**
 * Detection of an in-progress merge / rebase / cherry-pick.
 *
 * These states are only visible as marker files inside GIT_DIR, and git has no
 * command that reports them in a machine-readable, locale-independent way. They
 * are read through `workspace.fs` rather than by spawning `test` and `cat`:
 * `process:spawn` only permits git, node, bun, npx and sqlite3, so shelling out
 * to coreutils throws — and the caller's catch turned that into "no uncommitted
 * data at all" for exactly the conflicted repositories that needed it.
 */
import type { MergeState } from "./types.ts";
import type { VscodeApi } from "./git-exec.ts";
import { spawnGit } from "./git-exec.ts";

async function exists(vscode: VscodeApi, path: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(path));
    return true;
  } catch {
    // Missing, or outside the paths the host will read (a linked worktree's
    // GIT_DIR can live under the main repository). Either way: not detected.
    return false;
  }
}

async function readText(vscode: VscodeApi, path: string): Promise<string> {
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(path));
    return new TextDecoder().decode(bytes).trim();
  } catch {
    return "";
  }
}

/** Absolute GIT_DIR for the repository at `projectPath`, or null. */
export async function resolveGitDir(vscode: VscodeApi, projectPath: string): Promise<string | null> {
  const res = await spawnGit(vscode, ["rev-parse", "--git-dir"], projectPath, 2000);
  if (res.exitCode !== 0) return null;
  const gitDir = res.stdout.trim();
  if (!gitDir) return null;
  // `--git-dir` is relative when the cwd is the repository root.
  return /^([a-zA-Z]:[\\/]|[\\/])/.test(gitDir) ? gitDir : `${projectPath}/${gitDir}`;
}

export async function detectMergeState(
  vscode: VscodeApi,
  projectPath: string,
): Promise<MergeState | undefined> {
  const gitDir = await resolveGitDir(vscode, projectPath);
  if (!gitDir) return undefined;

  // Interactive rebase
  const rebaseMergeDir = `${gitDir}/rebase-merge`;
  if (await exists(vscode, rebaseMergeDir)) {
    const [current, total, message] = await Promise.all([
      readText(vscode, `${rebaseMergeDir}/msgnum`),
      readText(vscode, `${rebaseMergeDir}/end`),
      readText(vscode, `${rebaseMergeDir}/message`),
    ]);
    return {
      type: "rebase",
      progress: current && total ? `${current}/${total}` : undefined,
      message: message.split("\n")[0] || undefined,
    };
  }

  // Non-interactive rebase / git am
  if (await exists(vscode, `${gitDir}/rebase-apply`)) {
    return { type: "rebase" };
  }

  if (await exists(vscode, `${gitDir}/MERGE_HEAD`)) {
    return { type: "merge" };
  }

  if (await exists(vscode, `${gitDir}/CHERRY_PICK_HEAD`)) {
    return { type: "cherry-pick" };
  }

  return undefined;
}
