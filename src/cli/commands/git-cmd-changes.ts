import type { Command } from "commander";
import type { DiscardRecord, GitChanges } from "../../shared/git-changes.ts";
import { act, C, fail, gitCommand, gitRequest, report, type GitOpts } from "./git-cmd-shared.ts";

/** `ppm git stage|unstage|discard|commit` and `ppm git undo discard|commit`. Paths are repository-relative. */
export function registerGitChangeCommands(git: Command): void {
  gitCommand(git, "stage <files...>", 'Stage files (use "." to stage all)')
    .action((files: string[], o: GitOpts) => act(async () => {
      const data = await gitRequest("POST", o, "stage", { files });
      report(o, data, `${C.green}Staged:${C.reset} ${files.join(", ")}`);
    }));

  gitCommand(git, "unstage <files...>", "Unstage files")
    .action((files: string[], o: GitOpts) => act(async () => {
      const data = await gitRequest("POST", o, "unstage", { files });
      report(o, data, `${C.yellow}Unstaged:${C.reset} ${files.join(", ")}`);
    }));

  gitCommand(git, "discard <files...>", "Throw away the files' unstaged changes; PPM keeps a copy to undo it")
    .action((files: string[], o: GitOpts) => act(async () => {
      const data = await gitRequest<{ discarded: string[]; undo: DiscardRecord | null }>("POST", o, "discard", { files });
      const undo = data.undo ? ` ${C.dim}(undo: ppm git undo discard ${data.undo.id})${C.reset}` : "";
      const lost = data.undo?.skipped?.length ? `\n${C.yellow}Not kept, cannot be undone:${C.reset} ${data.undo.skipped.join(", ")}` : "";
      report(o, data, `${C.green}Discarded:${C.reset} ${files.join(", ")}${undo}${lost}`);
    }));

  gitCommand(git, "commit", "Commit the staged changes")
    .option("-m, --message <msg>", "Commit message (required unless --amend)")
    .option("--amend", "Replace the last commit")
    .option("--signoff", "Add a Signed-off-by line")
    .action((o: GitOpts & { message?: string; amend?: boolean; signoff?: boolean }) => act(async () => {
      if (!o.amend && !o.message) fail("A commit needs a message: -m <msg>");
      if (!o.amend) {
        const ch = await gitRequest<GitChanges>("GET", o, "changes");
        if (!ch.files.some((f) => f.staged)) fail("Nothing to commit. Stage files first with: ppm git stage <files>");
      }
      const data = await gitRequest<{ hash: string }>("POST", o, "commit", { message: o.message, amend: !!o.amend, signoff: !!o.signoff });
      report(o, data, `${C.green}Committed:${C.reset} ${C.yellow}${data.hash.slice(0, 7)}${C.reset}${o.message ? ` "${o.message}"` : ""}`);
    }));

  const undo = git.command("undo").description("Undo a discard or the last commit");

  gitCommand(undo, "discard <id>", "Put back what a discard threw away (the id 'ppm git discard' printed)")
    .action((id: string, o: GitOpts) => act(async () => {
      const data = await gitRequest("POST", o, "discard/undo", { id });
      report(o, data, `${C.green}Restored${C.reset} the discard ${id}`);
    }));

  gitCommand(undo, "commit <hash>", "Undo the last commit, keeping its changes staged; refused if it was pushed")
    .action((hash: string, o: GitOpts) => act(async () => {
      const data = await gitRequest<{ hash: string; message: string }>("POST", o, "commit/undo", { hash });
      report(o, data, `${C.green}Undid${C.reset} ${C.yellow}${data.hash.slice(0, 7)}${C.reset}; its changes are staged`);
    }));
}
