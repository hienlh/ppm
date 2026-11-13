import type { Command } from "commander";
import { act, C, gitCommand, gitRequest, report, REMOTE_TIMEOUT_MS, type GitOpts } from "./git-cmd-shared.ts";

/** `ppm git fetch|pull|push|publish`. The route checks a named remote is one the repository has. */
export function registerGitRemoteCommands(git: Command): void {
  gitCommand(git, "fetch", "Fetch from every remote, or one")
    .option("--remote <name>", "Only this remote")
    .option("--prune", "Drop remote-tracking branches the remote no longer has")
    .action((o: GitOpts & { remote?: string; prune?: boolean }) => act(async () => {
      const data = await gitRequest("POST", o, "fetch", { remote: o.remote, prune: !!o.prune }, {}, REMOTE_TIMEOUT_MS);
      report(o, data, `${C.green}Fetched${C.reset}${o.remote ? ` ${o.remote}` : ""}`);
    }));

  gitCommand(git, "pull", "Pull the current branch from its upstream")
    .option("--rebase", "Rebase instead of merging")
    .action((o: GitOpts & { rebase?: boolean }) => act(async () => {
      const data = await gitRequest("POST", o, "pull", { rebase: !!o.rebase }, {}, REMOTE_TIMEOUT_MS);
      report(o, data, `${C.green}Pulled successfully.${C.reset}`);
    }));

  gitCommand(git, "push", "Push the current branch, or a branch to a named remote")
    .option("--remote <name>", "A remote the repository has (default: the branch's own)")
    .option("--branch <name>", "The branch to push (needs --remote)")
    .action((o: GitOpts & { remote?: string; branch?: string }) => act(async () => {
      const data = await gitRequest("POST", o, "push", { remote: o.remote, branch: o.branch }, {}, REMOTE_TIMEOUT_MS);
      report(o, data, `${C.green}Pushed successfully.${C.reset}`);
    }));

  gitCommand(git, "publish", "Push a branch with no upstream and make the remote branch its upstream")
    .action((o: GitOpts) => act(async () => {
      const data = await gitRequest<{ remote: string; branch: string }>("POST", o, "publish", {}, {}, REMOTE_TIMEOUT_MS);
      report(o, data, `${C.green}Published${C.reset} ${data.branch} to ${data.remote}`);
    }));
}
