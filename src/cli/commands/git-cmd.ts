import { Command } from "commander";
import type { ChangedFile, ChangeSide, GitChanges } from "../../shared/git-changes.ts";
import type { GitGraphData } from "../../types/git.ts";
import { act, C, gitCommand, gitRequest, type GitOpts } from "./git-cmd-shared.ts";
import { registerGitChangeCommands } from "./git-cmd-changes.ts";
import { registerGitRemoteCommands } from "./git-cmd-remote.ts";
import { registerGitBranchCommands } from "./git-cmd-branches.ts";
import { registerGitStashWorktreeCommands } from "./git-cmd-stash-worktree.ts";

/**
 * `ppm git`: everything Source Control does, through the project's git routes (see
 * `git-cmd-shared.ts`). Block-level staging stays in PPM's screens: choosing blocks by key is not
 * something a terminal does well.
 */

function counts(side: ChangeSide): string {
  return side.whole ? `${C.dim}(${side.whole})${C.reset}` : `${C.green}+${side.added}${C.reset} ${C.red}-${side.removed}${C.reset}`;
}

function label(f: ChangedFile): string {
  return f.oldPath ? `${f.oldPath} → ${f.path}` : f.path;
}

function printChanges(ch: GitChanges): void {
  const b = ch.branch;
  const track = b.upstream
    ? ` ${C.dim}→ ${b.upstream}${b.upstreamGone ? " (gone)" : ` ↑${b.ahead} ↓${b.behind}`}${C.reset}`
    : b.hasRemote ? ` ${C.dim}(not published)${C.reset}` : "";
  console.log(`${C.bold}On branch:${C.reset} ${C.cyan}${b.head ?? "(detached)"}${C.reset}${track}`);
  if (ch.operation) console.log(`${C.yellow}A ${ch.operation.kind} is under way:${C.reset} finish it with 'ppm git continue' or 'ppm git abort'`);
  const conflicts = ch.files.filter((f) => f.conflict);
  const staged = ch.files.filter((f) => !f.conflict && f.staged);
  const unstaged = ch.files.filter((f) => !f.conflict && !f.untracked && f.unstaged);
  const untracked = ch.files.filter((f) => f.untracked);
  if (!ch.files.length) console.log(`${C.green}Nothing to commit, working tree clean${C.reset}`);
  const section = (title: string, files: ChangedFile[], line: (f: ChangedFile) => string) => {
    if (!files.length) return;
    console.log(`\n${C.bold}${title}:${C.reset}`);
    for (const f of files) console.log(`  ${line(f)}`);
  };
  section("Conflicts", conflicts, (f) => `${C.red}!${C.reset}  ${f.path}`);
  section("Staged changes", staged, (f) => `${C.yellow}${f.x}${C.reset}  ${label(f)}  ${counts(f.staged!)}`);
  section("Unstaged changes", unstaged, (f) => `${C.yellow}${f.y}${C.reset}  ${f.path}  ${counts(f.unstaged!)}`);
  section("Untracked files", untracked, (f) => `${C.dim}?${C.reset}  ${f.path}`);
  if (ch.stashes) console.log(`\n${C.dim}${ch.stashes} stash${ch.stashes === 1 ? "" : "es"} (ppm git stash list)${C.reset}`);
}

function printDiff(diff: string): void {
  if (!diff.trim()) return void console.log(`${C.dim}No differences.${C.reset}`);
  for (const line of diff.split("\n")) {
    const color = line.startsWith("@@") ? C.cyan
      : line.startsWith("+") && !line.startsWith("+++") ? C.green
      : line.startsWith("-") && !line.startsWith("---") ? C.red : "";
    process.stdout.write(color ? `${color}${line}${C.reset}\n` : `${line}\n`);
  }
}

export function registerGitCommands(program: Command): void {
  const git = program.command("git").description("Git operations for a project, through the running PPM");

  gitCommand(git, "status", "Show the branch and every changed file, as Source Control does")
    .action((o: GitOpts) => act(async () => {
      const ch = await gitRequest<GitChanges>("GET", o, "changes");
      if (o.json) console.log(JSON.stringify(ch, null, 2));
      else printChanges(ch);
    }));

  gitCommand(git, "log", "Show recent commits")
    .option("-n, --count <n>", "Number of commits to show", "20")
    .action((o: GitOpts & { count: string }) => act(async () => {
      const max = Math.min(Math.max(parseInt(o.count, 10) || 20, 1), 500);
      const data = await gitRequest<GitGraphData>("GET", o, "graph", undefined, { max });
      if (o.json) return void console.log(JSON.stringify(data.commits, null, 2));
      if (!data.commits.length) return void console.log(`${C.yellow}No commits found.${C.reset}`);
      for (const c of data.commits) {
        const refs = c.refs.length ? ` ${C.green}(${c.refs.join(", ")})${C.reset}` : "";
        console.log(`${C.yellow}${c.abbreviatedHash}${C.reset}${refs} ${c.subject}`);
        console.log(`       ${C.cyan}${c.authorName}${C.reset} · ${C.dim}${new Date(c.authorDate).toLocaleDateString()}${C.reset}`);
      }
    }));

  gitCommand(git, "diff [ref1] [ref2]", "Show the diff between two refs, or of the working tree")
    .action((ref1: string | undefined, ref2: string | undefined, o: GitOpts) => act(async () => {
      const { diff } = await gitRequest<{ diff: string }>("GET", o, "diff", undefined, { ref1, ref2 });
      if (o.json) console.log(JSON.stringify({ diff }, null, 2));
      else printDiff(diff);
    }));

  registerGitChangeCommands(git);
  registerGitRemoteCommands(git);
  registerGitBranchCommands(git);
  registerGitStashWorktreeCommands(git);
}
