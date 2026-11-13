import type { Command } from "commander";
import { act, C, fail, gitCommand, gitRequest, report, type GitOpts } from "./git-cmd-shared.ts";

/**
 * `ppm git branch create|checkout|delete|merge` (the names `ppm git` always had), and
 * `ppm git cherry-pick|revert|tag|abort|continue`. The routes refuse any ref or hash git would
 * read as an option.
 */
export function registerGitBranchCommands(git: Command): void {
  const branch = git.command("branch").description("Branch operations");

  gitCommand(branch, "create <name>", "Create a branch and check it out")
    .option("--from <ref>", "Base ref (commit/branch/tag)")
    .action((name: string, o: GitOpts & { from?: string }) => act(async () => {
      const data = await gitRequest("POST", o, "branch/create", { name, from: o.from });
      report(o, data, `${C.green}Created and checked out branch:${C.reset} ${C.cyan}${name}${C.reset}`);
    }));

  gitCommand(branch, "checkout <name>", "Switch to a branch, tag or commit")
    .option("--detach", "Check out the commit itself, on no branch")
    .option("--track", "For a remote branch: create the local branch that follows it")
    .action((name: string, o: GitOpts & { detach?: boolean; track?: boolean }) => act(async () => {
      if (o.detach && o.track) fail("Choose one of --detach and --track");
      const mode = o.detach ? "detach" : o.track ? "track" : "checkout";
      const data = await gitRequest("POST", o, "checkout", { ref: name, mode });
      report(o, data, `${C.green}Switched to:${C.reset} ${C.cyan}${name}${C.reset}`);
    }));

  gitCommand(branch, "delete <name>", "Delete a branch")
    .option("-f, --force", "Delete it even when it is not merged")
    .action((name: string, o: GitOpts & { force?: boolean }) => act(async () => {
      const data = await gitRequest("POST", o, "branch/delete", { name, force: !!o.force });
      report(o, data, `${C.green}Deleted branch:${C.reset} ${C.cyan}${name}${C.reset}`);
    }));

  gitCommand(branch, "merge <source>", "Merge a branch into the current branch")
    .action((source: string, o: GitOpts) => act(async () => {
      const data = await gitRequest("POST", o, "merge", { source });
      report(o, data, `${C.green}Merged:${C.reset} ${C.cyan}${source}${C.reset} into the current branch`);
    }));

  gitCommand(git, "cherry-pick <hash>", "Apply one commit's change on the current branch")
    .action((hash: string, o: GitOpts) => act(async () => {
      const data = await gitRequest("POST", o, "cherry-pick", { hash });
      report(o, data, `${C.green}Cherry-picked${C.reset} ${C.yellow}${hash.slice(0, 7)}${C.reset}`);
    }));

  gitCommand(git, "revert <hash>", "Make a commit that undoes another")
    .action((hash: string, o: GitOpts) => act(async () => {
      const data = await gitRequest("POST", o, "revert", { hash });
      report(o, data, `${C.green}Reverted${C.reset} ${C.yellow}${hash.slice(0, 7)}${C.reset}`);
    }));

  gitCommand(git, "tag <name>", "Tag the current commit, or another")
    .option("--at <hash>", "The commit to tag (default: HEAD)")
    .action((name: string, o: GitOpts & { at?: string }) => act(async () => {
      const data = await gitRequest("POST", o, "tag", { name, hash: o.at });
      report(o, data, `${C.green}Tagged${C.reset} ${C.cyan}${name}${C.reset}${o.at ? ` at ${o.at.slice(0, 7)}` : ""}`);
    }));

  for (const action of ["abort", "continue"] as const) {
    gitCommand(git, action, `${action === "abort" ? "Abandon" : "Finish"} the merge, rebase, cherry-pick or revert that stopped part way`)
      .action((o: GitOpts) => act(async () => {
        const data = await gitRequest<{ kind: string }>("POST", o, `operation/${action}`);
        report(o, data, `${C.green}${action === "abort" ? "Abandoned" : "Continued"}${C.reset} the ${data.kind}`);
      }));
  }
}
