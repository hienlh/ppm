import { Command } from "commander";
import type { GitStatus } from "../../types/git.ts";

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
  magenta: "\x1b[35m",
};

function statusColor(s: string): string {
  if (s === "M") return `${C.yellow}M${C.reset}`;
  if (s === "A") return `${C.green}A${C.reset}`;
  if (s === "D") return `${C.red}D${C.reset}`;
  if (s === "R") return `${C.cyan}R${C.reset}`;
  return s;
}

function printStatus(status: GitStatus): void {
  console.log(`${C.bold}On branch:${C.reset} ${C.cyan}${status.current ?? "(detached)"}${C.reset}`);

  if (status.staged.length === 0 && status.unstaged.length === 0 && status.untracked.length === 0) {
    console.log(`${C.green}Nothing to commit, working tree clean${C.reset}`);
    return;
  }

  if (status.staged.length > 0) {
    console.log(`\n${C.bold}Staged changes:${C.reset}`);
    for (const f of status.staged) {
      const label = f.oldPath ? `${f.oldPath} → ${f.path}` : f.path;
      console.log(`  ${statusColor(f.status)}  ${label}`);
    }
  }

  if (status.unstaged.length > 0) {
    console.log(`\n${C.bold}Unstaged changes:${C.reset}`);
    for (const f of status.unstaged) {
      console.log(`  ${statusColor(f.status)}  ${f.path}`);
    }
  }

  if (status.untracked.length > 0) {
    console.log(`\n${C.bold}Untracked files:${C.reset}`);
    for (const f of status.untracked) {
      console.log(`  ${C.dim}?  ${f}${C.reset}`);
    }
  }
}

export function registerGitCommands(program: Command): void {
  const git = program.command("git").description("Git operations for a project");

  git
    .command("status")
    .description("Show working tree status")
    .option("-p, --project <name>", "Project name or path")
    .action(async (options: { project?: string }) => {
      try {
        const { resolveProject } = await import("../utils/project-resolver.ts");
        const { gitService } = await import("../../services/git.service.ts");
        const project = resolveProject(options);
        const status = await gitService.status(project.path);
        printStatus(status);
      } catch (err) {
        console.error(`${C.red}Error:${C.reset}`, (err as Error).message);
        process.exit(1);
      }
    });

  git
    .command("log")
    .description("Show recent commits")
    .option("-p, --project <name>", "Project name or path")
    .option("-n, --count <n>", "Number of commits to show", "20")
    .action(async (options: { project?: string; count?: string }) => {
      try {
        const { resolveProject } = await import("../utils/project-resolver.ts");
        const { gitService } = await import("../../services/git.service.ts");
        const project = resolveProject(options);
        const maxCount = Math.min(parseInt(options.count ?? "20", 10), 500);
        const { commits } = await gitService.graphData(project.path, maxCount);

        if (commits.length === 0) {
          console.log(`${C.yellow}No commits found.${C.reset}`);
          return;
        }

        for (const c of commits) {
          const hash = `${C.yellow}${c.abbreviatedHash}${C.reset}`;
          const subject = c.subject;
          const author = `${C.cyan}${c.authorName}${C.reset}`;
          const date = `${C.dim}${new Date(c.authorDate).toLocaleDateString()}${C.reset}`;
          const refs = c.refs.length > 0
            ? ` ${C.green}(${c.refs.join(", ")})${C.reset}`
            : "";
          console.log(`${hash}${refs} ${subject}`);
          console.log(`       ${author} · ${date}`);
        }
      } catch (err) {
        console.error(`${C.red}Error:${C.reset}`, (err as Error).message);
        process.exit(1);
      }
    });

  git
    .command("diff")
    .description("Show diff between refs or working tree")
    .option("-p, --project <name>", "Project name or path")
    .argument("[ref1]", "First ref")
    .argument("[ref2]", "Second ref")
    .action(async (ref1: string | undefined, ref2: string | undefined, options: { project?: string }) => {
      try {
        const { resolveProject } = await import("../utils/project-resolver.ts");
        const { gitService } = await import("../../services/git.service.ts");
        const project = resolveProject(options);
        const diff = await gitService.diff(project.path, ref1, ref2);
        if (!diff.trim()) {
          console.log(`${C.dim}No differences.${C.reset}`);
        } else {
          // Color diff output
          for (const line of diff.split("\n")) {
            if (line.startsWith("+") && !line.startsWith("+++")) {
              process.stdout.write(`${C.green}${line}${C.reset}\n`);
            } else if (line.startsWith("-") && !line.startsWith("---")) {
              process.stdout.write(`${C.red}${line}${C.reset}\n`);
            } else if (line.startsWith("@@")) {
              process.stdout.write(`${C.cyan}${line}${C.reset}\n`);
            } else {
              process.stdout.write(`${line}\n`);
            }
          }
        }
      } catch (err) {
        console.error(`${C.red}Error:${C.reset}`, (err as Error).message);
        process.exit(1);
      }
    });

  git
    .command("stage <files...>")
    .description('Stage files (use "." to stage all)')
    .option("-p, --project <name>", "Project name or path")
    .action(async (files: string[], options: { project?: string }) => {
      try {
        const { resolveProject } = await import("../utils/project-resolver.ts");
        const { gitService } = await import("../../services/git.service.ts");
        const project = resolveProject(options);
        await gitService.stage(project.path, files);
        console.log(`${C.green}Staged:${C.reset} ${files.join(", ")}`);
      } catch (err) {
        console.error(`${C.red}Error:${C.reset}`, (err as Error).message);
        process.exit(1);
      }
    });

  git
    .command("unstage <files...>")
    .description("Unstage files")
    .option("-p, --project <name>", "Project name or path")
    .action(async (files: string[], options: { project?: string }) => {
      try {
        const { resolveProject } = await import("../utils/project-resolver.ts");
        const { gitService } = await import("../../services/git.service.ts");
        const project = resolveProject(options);
        await gitService.unstage(project.path, files);
        console.log(`${C.yellow}Unstaged:${C.reset} ${files.join(", ")}`);
      } catch (err) {
        console.error(`${C.red}Error:${C.reset}`, (err as Error).message);
        process.exit(1);
      }
    });

  git
    .command("commit")
    .description("Commit staged changes")
    .option("-p, --project <name>", "Project name or path")
    .requiredOption("-m, --message <msg>", "Commit message")
    .action(async (options: { project?: string; message: string }) => {
      try {
        const { resolveProject } = await import("../utils/project-resolver.ts");
        const { gitService } = await import("../../services/git.service.ts");
        const project = resolveProject(options);

        // Check if there's anything to commit
        const status = await gitService.status(project.path);
        if (status.staged.length === 0) {
          console.error(`${C.red}Nothing to commit.${C.reset} Stage files first with: ppm git stage <files>`);
          process.exit(1);
        }

        const hash = await gitService.commit(project.path, options.message);
        console.log(`${C.green}Committed:${C.reset} ${C.yellow}${hash}${C.reset} "${options.message}"`);
      } catch (err) {
        console.error(`${C.red}Error:${C.reset}`, (err as Error).message);
        process.exit(1);
      }
    });

  git
    .command("push")
    .description("Push to remote")
    .option("-p, --project <name>", "Project name or path")
    .option("--remote <remote>", "Remote name", "origin")
    .option("--branch <branch>", "Branch name")
    .action(async (options: { project?: string; remote?: string; branch?: string }) => {
      try {
        const { resolveProject } = await import("../utils/project-resolver.ts");
        const { gitService } = await import("../../services/git.service.ts");
        const project = resolveProject(options);
        console.log(`${C.dim}Pushing...${C.reset}`);
        await gitService.push(project.path, options.remote, options.branch);
        console.log(`${C.green}Pushed successfully.${C.reset}`);
      } catch (err) {
        console.error(`${C.red}Error:${C.reset}`, (err as Error).message);
        process.exit(1);
      }
    });

  git
    .command("pull")
    .description("Pull from remote")
    .option("-p, --project <name>", "Project name or path")
    .option("--remote <remote>", "Remote name")
    .option("--branch <branch>", "Branch name")
    .action(async (options: { project?: string; remote?: string; branch?: string }) => {
      try {
        const { resolveProject } = await import("../utils/project-resolver.ts");
        const { gitService } = await import("../../services/git.service.ts");
        const project = resolveProject(options);
        console.log(`${C.dim}Pulling...${C.reset}`);
        await gitService.pull(project.path, options.remote, options.branch);
        console.log(`${C.green}Pulled successfully.${C.reset}`);
      } catch (err) {
        console.error(`${C.red}Error:${C.reset}`, (err as Error).message);
        process.exit(1);
      }
    });

  // ppm git branch <subcommand>
  const branch = git.command("branch").description("Branch operations");

  branch
    .command("create <name>")
    .description("Create and checkout a new branch")
    .option("-p, --project <name>", "Project name or path")
    .option("--from <ref>", "Base ref (commit/branch/tag)")
    .action(async (name: string, options: { project?: string; from?: string }) => {
      try {
        const { resolveProject } = await import("../utils/project-resolver.ts");
        const { gitService } = await import("../../services/git.service.ts");
        const project = resolveProject(options);
        await gitService.createBranch(project.path, name, options.from);
        console.log(`${C.green}Created and checked out branch:${C.reset} ${C.cyan}${name}${C.reset}`);
      } catch (err) {
        console.error(`${C.red}Error:${C.reset}`, (err as Error).message);
        process.exit(1);
      }
    });

  branch
    .command("checkout <name>")
    .description("Switch to a branch")
    .option("-p, --project <name>", "Project name or path")
    .action(async (name: string, options: { project?: string }) => {
      try {
        const { resolveProject } = await import("../utils/project-resolver.ts");
        const { gitService } = await import("../../services/git.service.ts");
        const project = resolveProject(options);
        await gitService.checkout(project.path, name);
        console.log(`${C.green}Switched to branch:${C.reset} ${C.cyan}${name}${C.reset}`);
      } catch (err) {
        console.error(`${C.red}Error:${C.reset}`, (err as Error).message);
        process.exit(1);
      }
    });

  branch
    .command("delete <name>")
    .description("Delete a branch")
    .option("-p, --project <name>", "Project name or path")
    .option("-f, --force", "Force delete")
    .action(async (name: string, options: { project?: string; force?: boolean }) => {
      try {
        const { resolveProject } = await import("../utils/project-resolver.ts");
        const { gitService } = await import("../../services/git.service.ts");
        const project = resolveProject(options);
        await gitService.deleteBranch(project.path, name, options.force);
        console.log(`${C.green}Deleted branch:${C.reset} ${C.cyan}${name}${C.reset}`);
      } catch (err) {
        console.error(`${C.red}Error:${C.reset}`, (err as Error).message);
        process.exit(1);
      }
    });

  branch
    .command("merge <source>")
    .description("Merge a branch into current branch")
    .option("-p, --project <name>", "Project name or path")
    .action(async (source: string, options: { project?: string }) => {
      try {
        const { resolveProject } = await import("../utils/project-resolver.ts");
        const { gitService } = await import("../../services/git.service.ts");
        const project = resolveProject(options);
        await gitService.merge(project.path, source);
        console.log(`${C.green}Merged:${C.reset} ${C.cyan}${source}${C.reset} into current branch`);
      } catch (err) {
        console.error(`${C.red}Error:${C.reset}`, (err as Error).message);
        process.exit(1);
      }
    });
}
