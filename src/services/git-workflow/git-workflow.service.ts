/**
 * The commands behind Source Control's buttons that PPM had no route for:
 * undo the last commit, publish a branch, pull with rebase, and the stash.
 */
import type { GitOperationKind, StashEntry } from "../../shared/git-changes.ts";
import { gitChangesService } from "../git-changes/git-changes.service.ts";
import { runGit, toDisplay } from "../git-hunks/git-hunks.service.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("git");

async function git(cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
  const res = await runGit(cwd, args, { env });
  if (res.exitCode !== 0) throw new Error(res.stderr.trim() || `git ${args[0]} exited with ${res.exitCode}`);
  return toDisplay(res.stdout);
}

/** The commit-message parts of a stash subject: "On main: wip" / "WIP on main: abc1234 Subject". */
export function parseStashSubject(subject: string): { branch: string | null; message: string } {
  const named = /^On ([^:]+): (.*)$/s.exec(subject);
  if (named) return { branch: named[1]!, message: named[2]! };
  const auto = /^WIP on ([^:]+): (?:[0-9a-f]+ )?(.*)$/s.exec(subject);
  if (auto) return { branch: auto[1]!, message: auto[2]! };
  return { branch: null, message: subject };
}

/**
 * The configuration already says how a pull reconciles: `pull.rebase`, the
 * branch's own `branch.<name>.rebase`, or `pull.ff` — which `--no-rebase` on
 * the command line would override, letting `ff = only` merge after all.
 */
async function pullStrategyConfigured(cwd: string): Promise<boolean> {
  const head = await runGit(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]);
  const branch = head.exitCode === 0 ? toDisplay(head.stdout).trim() : "";
  for (const key of ["pull.rebase", "pull.ff", ...(branch ? [`branch.${branch}.rebase`] : [])]) {
    const res = await runGit(cwd, ["config", "--get", key]);
    if (res.exitCode === 0 && res.stdout.trim()) return true;
  }
  return false;
}

export const gitWorkflowService = {
  /**
   * Take the last commit back into the index, as if it had never been made,
   * and hand back its message so it can go back into the message box.
   *
   * `hash` is the commit the user means — the one the toast or the box named.
   * Only that one is taken back, and only while it is still the last commit:
   * by the time Undo is clicked, a commit from a terminal or a pull may have
   * landed on top, and "the last commit" would then be one they never saw.
   *
   * Refused also once the commit is on a remote (undoing it would rewrite
   * history someone may have), for the root commit (a soft reset needs a
   * parent), and while a merge or rebase is under way (HEAD is not the commit
   * the user thinks it is).
   */
  async undoLastCommit(cwd: string, hash: string): Promise<{ hash: string; message: string }> {
    // At least 40 hex digits: that is what `/commit` answers with, in a
    // SHA-256 repository too, where it is the first 40 of 64.
    if (!/^[0-9a-f]{40,64}$/.test(hash)) throw new Error("Invalid commit id.");
    gitChangesService.invalidate(cwd);
    const changes = await gitChangesService.getChanges(cwd);
    const last = changes.lastCommit;
    if (!last) throw new Error("There is no commit to undo.");
    if (!last.hash.startsWith(hash)) {
      throw new Error(`The last commit is no longer ${hash.slice(0, 7)}, so nothing was undone.`);
    }
    if (changes.operation) throw new Error(`Finish or abort the ${changes.operation.kind} first.`);
    if (!last.hasParent) throw new Error("The first commit of a repository cannot be undone this way.");
    if (last.pushed) throw new Error("This commit is already on the remote, so undoing it would rewrite pushed history.");

    const message = (await git(cwd, ["log", "-1", "--format=%B", last.hash])).replace(/\n+$/, "");
    // A soft reset, moving HEAD only while it is still that commit: `update-ref`
    // with the old value refuses once anything moved it since it was read, where
    // `reset --soft <hash>~1` would take back whatever had landed on top as well.
    await git(cwd, ["update-ref", "-m", `undo commit ${last.hash.slice(0, 7)}`, "HEAD", `${last.hash}~1`, last.hash]);
    log.info(`undid commit ${last.hash.slice(0, 7)} in ${cwd} (soft reset)`);
    return { hash: last.hash, message };
  },

  /** Push a branch that has no upstream yet, and make the remote branch its upstream. */
  async publish(cwd: string): Promise<{ remote: string; branch: string }> {
    const branch = (await runGit(cwd, ["symbolic-ref", "--short", "-q", "HEAD"])).stdout.trim();
    if (!branch) throw new Error("HEAD is detached: check out a branch to publish it.");
    const remotes = (await git(cwd, ["remote"])).split("\n").map((r) => r.trim()).filter(Boolean);
    const remote = remotes.includes("origin") ? "origin" : remotes[0];
    if (!remote) throw new Error("This repository has no remote to publish to.");
    await git(cwd, ["push", "-u", remote, toDisplay(branch)]);
    log.info(`published ${toDisplay(branch)} to ${remote} in ${cwd}`);
    return { remote, branch: toDisplay(branch) };
  },

  /**
   * Abort or continue the merge, rebase, cherry-pick, revert or `git am` that
   * stopped part way. Continue commits with the message git prepared:
   * `GIT_EDITOR=:` is git's own "no editor" value, so nothing is launched and
   * the command cannot sit waiting for a terminal that is not there.
   */
  async operation(cwd: string, action: "abort" | "continue"): Promise<GitOperationKind> {
    gitChangesService.invalidate(cwd);
    const { operation, files } = await gitChangesService.getChanges(cwd);
    if (!operation) throw new Error(`There is no merge, rebase or cherry-pick to ${action}.`);
    if (action === "continue" && files.some((f) => f.conflict)) {
      throw new Error("Resolve every conflict and stage the result first.");
    }
    await git(cwd, [operation.kind, `--${action}`], { GIT_EDITOR: ":" });
    log.info(`${operation.kind} --${action} in ${cwd}`);
    return operation.kind;
  },

  /**
   * `git pull` refuses a branch that has diverged from its upstream (git ≥ 2.33)
   * until the configuration says how to reconcile the two — and Sync is offered
   * exactly when it has. With nothing configured this merges, which is what
   * every git did before it started asking; a configured choice is left to git.
   */
  async pull(cwd: string, options: { rebase?: boolean } = {}): Promise<void> {
    const started = performance.now();
    const configured = !options.rebase && await pullStrategyConfigured(cwd);
    await git(cwd, options.rebase ? ["pull", "--rebase"] : configured ? ["pull"] : ["pull", "--no-rebase"]);
    const how = options.rebase ? "--rebase" : configured ? "the configured strategy" : "--no-rebase";
    log.info(`pulled in ${cwd} (${how}) in ${Math.round(performance.now() - started)} ms`);
  },

  async listStashes(cwd: string): Promise<StashEntry[]> {
    const res = await runGit(cwd, ["stash", "list", "-z", "--format=%H%x1f%P%x1f%gs%x1f%cI"]);
    if (res.exitCode !== 0) return [];
    return res.stdout.split("\0").filter(Boolean).map((record, index) => {
      const [hash = "", parents = "", subject = "", date = ""] = toDisplay(record).split("\x1f");
      const { branch, message } = parseStashSubject(subject);
      return { index, hash, base: parents.split(" ")[0] || null, branch, message, date };
    });
  },

  async stash(cwd: string, options: { message?: string; includeUntracked?: boolean } = {}): Promise<void> {
    const args = ["stash", "push"];
    if (options.includeUntracked) args.push("--include-untracked");
    if (options.message?.trim()) args.push("-m", options.message.trim());
    await git(cwd, args);
    log.info(`stashed in ${cwd} (untracked=${!!options.includeUntracked})`);
  },

  /**
   * Apply, pop or drop one stash, named by index *and* commit id. Indexes shift
   * every time a stash is added or dropped, so an index alone could act on a
   * different stash than the one on screen.
   *
   * Applied with `--index`, so what was staged comes back staged: a stash is
   * as often as not taken half way through staging block by block, and the
   * Undo after "Stash all changes" has to be an undo. When the staged part no
   * longer applies on its own, git refuses before touching anything, and the
   * work is applied without it — `indexRestored: false` says so.
   */
  async stashAction(
    cwd: string,
    action: "apply" | "pop" | "drop",
    index: number,
    hash: string,
  ): Promise<{ indexRestored?: boolean }> {
    if (!Number.isInteger(index) || index < 0) throw new Error("Invalid stash index.");
    if (!/^[0-9a-f]{40,64}$/.test(hash)) throw new Error("Invalid stash id.");
    const ref = `stash@{${index}}`;
    const current = (await runGit(cwd, ["rev-parse", "--verify", "-q", ref])).stdout.trim();
    if (current !== hash) throw new Error("The stash list changed. Reload it and try again.");
    const what = `stash ${action} ${ref} ${hash.slice(0, 7)} in ${cwd}`;
    if (action === "drop") {
      await git(cwd, ["stash", "drop", ref]);
      log.info(what);
      return {};
    }
    // In git's English: its stderr is how the fallback below is chosen, and it
    // follows the locale, so a German one would make every fallback an error.
    const withIndex = await runGit(cwd, ["stash", action, "--index", ref], { env: { LC_ALL: "C" } });
    if (withIndex.exitCode === 0) {
      log.info(what);
      return { indexRestored: true };
    }
    if (!/conflicts in index/i.test(withIndex.stderr)) {
      throw new Error(withIndex.stderr.trim() || `git stash ${action} exited with ${withIndex.exitCode}`);
    }
    await git(cwd, ["stash", action, ref]);
    log.warn(`${what}: index not restored, applied without --index`);
    return { indexRestored: false };
  },
};
