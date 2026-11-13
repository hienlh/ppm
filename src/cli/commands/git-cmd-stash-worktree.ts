import { resolve } from "node:path";
import type { Command } from "commander";
import type { StashEntry } from "../../shared/git-changes.ts";
import type { GitWorktree } from "../../types/git.ts";
import { act, C, fail, gitCommand, gitRequest, report, type GitOpts } from "./git-cmd-shared.ts";

/**
 * `ppm git stash save|list|apply|pop|drop` and `ppm git worktree list|add|remove|prune`.
 *
 * A stash is acted on by index *and* hash, which the route requires: indexes shift whenever a
 * stash is made or dropped, so the hash read here (or the one `--expect` names) is checked again
 * right before git runs, and a stash that moved is refused rather than the wrong one popped.
 * Worktree paths are resolved here, where they were typed.
 */
export function registerGitStashWorktreeCommands(git: Command): void {
  const stash = git.command("stash").description("Save, list and restore stashes");

  gitCommand(stash, "save", "Stash the working tree's changes")
    .option("-m, --message <msg>", "A message for the stash")
    .option("-u, --include-untracked", "Stash untracked files too")
    .action((o: GitOpts & { message?: string; includeUntracked?: boolean }) => act(async () => {
      const data = await gitRequest<{ stashed: boolean; stash: StashEntry | null }>("POST", o, "stash", {
        message: o.message, includeUntracked: !!o.includeUntracked,
      });
      report(o, data, data.stash ? `${C.green}Stashed${C.reset} as stash@{${data.stash.index}}` : `${C.dim}Nothing to stash.${C.reset}`);
    }));

  gitCommand(stash, "list", "List the stashes")
    .action((o: GitOpts) => act(async () => {
      const list = await gitRequest<StashEntry[]>("GET", o, "stashes");
      if (o.json) return void console.log(JSON.stringify(list, null, 2));
      if (!list.length) return void console.log(`${C.dim}No stashes.${C.reset}`);
      for (const s of list) console.log(`stash@{${s.index}} ${C.yellow}${s.hash}${C.reset} ${s.branch ? `${C.cyan}${s.branch}${C.reset} ` : ""}${s.message}`);
    }));

  for (const action of ["apply", "pop", "drop"] as const) {
    gitCommand(stash, `${action} <index>`, `${action === "drop" ? "Delete" : action === "pop" ? "Restore and delete" : "Restore"} stash@{index}`)
      .option("--expect <hash>", "Act only if the stash at that index is still this one (its full hash, as 'stash list' prints)")
      .action((index: string, o: GitOpts & { expect?: string }) => act(async () => {
        const n = Number(index);
        if (!Number.isInteger(n) || n < 0) fail(`Not a stash index: ${index}`);
        // With --expect the route checks that hash itself; without it, the one read just now.
        let hash = o.expect?.toLowerCase();
        if (!hash) {
          const list = await gitRequest<StashEntry[]>("GET", o, "stashes");
          hash = (list.find((s) => s.index === n) ?? fail(`There is no stash@{${n}}`)).hash;
        }
        const data = await gitRequest<{ indexRestored?: boolean }>("POST", o, `stash/${action}`, { index: n, hash });
        const note = data.indexRestored === false ? ` ${C.yellow}(its staged changes came back unstaged)${C.reset}` : "";
        report(o, data, `${C.green}${action === "drop" ? "Dropped" : action === "pop" ? "Popped" : "Applied"}${C.reset} stash@{${n}}${note}`);
      }));
  }

  const worktree = git.command("worktree").description("Linked worktrees");

  gitCommand(worktree, "list", "List the repository's worktrees")
    .action((o: GitOpts) => act(async () => {
      const list = await gitRequest<GitWorktree[]>("GET", o, "worktrees");
      if (o.json) return void console.log(JSON.stringify(list, null, 2));
      for (const w of list) {
        const flags = [w.isMain && "main", w.isDetached && "detached", w.locked && "locked", w.prunable && "prunable"].filter(Boolean);
        console.log(`${w.path} ${C.cyan}${w.branch || w.head.slice(0, 7)}${C.reset}${flags.length ? ` ${C.dim}(${flags.join(", ")})${C.reset}` : ""}`);
      }
    }));

  gitCommand(worktree, "add <path>", "Add a worktree beside the repository")
    .option("--branch <ref>", "An existing branch to check out in it")
    .option("-b, --new-branch <name>", "Create this branch for it")
    .action((path: string, o: GitOpts & { branch?: string; newBranch?: string }) => act(async () => {
      const abs = resolve(path);
      const data = await gitRequest("POST", o, "worktree/add", { path: abs, branch: o.branch, newBranch: o.newBranch });
      report(o, data, `${C.green}Added worktree${C.reset} ${abs}`);
    }));

  gitCommand(worktree, "remove <path>", "Remove a linked worktree")
    .option("-f, --force", "Remove it even with uncommitted changes")
    .action((path: string, o: GitOpts & { force?: boolean }) => act(async () => {
      const abs = resolve(path);
      const data = await gitRequest("POST", o, "worktree/remove", { path: abs, force: !!o.force });
      report(o, data, `${C.green}Removed worktree${C.reset} ${abs}`);
    }));

  gitCommand(worktree, "prune", "Forget worktrees whose folders are gone")
    .action((o: GitOpts) => act(async () => {
      const data = await gitRequest("POST", o, "worktree/prune");
      report(o, data, `${C.green}Pruned${C.reset} stale worktree records`);
    }));
}
