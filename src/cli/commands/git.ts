import type { Command } from "commander";
import { configService } from "../../services/config.service.ts";
import { ProjectService } from "../../services/project.service.ts";
import { resolveProject } from "../utils/project-resolver.ts";

const G = "\x1b[32m";
const R = "\x1b[31m";
const Y = "\x1b[33m";
const C = "\x1b[36m";
const RESET = "\x1b[0m";

function statusColor(status: string): string {
  if (status === "added") return G;
  if (status === "deleted") return R;
  return Y;
}

async function getGitService() {
  const { gitService } = await import("../../services/git.service.ts");
  return gitService;
}

function projectOptions(cmd: ReturnType<Command["command"]>) {
  return cmd.option("-p, --project <name>", "Project name or path (default: CWD)");
}

export function registerGitCommands(program: Command): void {
  const git = program.command("git").description("Git operations for a project");

  projectOptions(
    git.command("status").description("Show working tree status")
  ).action(async (opts: { project?: string }) => {
    configService.load();
    const ps = new ProjectService(configService);
    const project = resolveProject(ps, opts.project);
    const svc = await getGitService();
    const status = await svc.status(project.path);
    console.log(`${C}Branch:${RESET} ${status.branch}  ahead ${status.ahead}  behind ${status.behind}`);
    if (status.files.length === 0) {
      console.log("nothing to commit, working tree clean");
      return;
    }
    for (const f of status.files) {
      const col = statusColor(f.status);
      const mark = f.staged ? "S" : " ";
      console.log(`  [${mark}] ${col}${f.status.padEnd(8)}${RESET}  ${f.path}`);
    }
  });

  projectOptions(
    git.command("log").description("Show commit log")
  )
    .option("-n, --count <n>", "Number of commits", "20")
    .action(async (opts: { project?: string; count?: string }) => {
      configService.load();
      const ps = new ProjectService(configService);
      const project = resolveProject(ps, opts.project);
      const svc = await getGitService();
      const n = parseInt(opts.count ?? "20", 10);
      const data = await svc.graphData(project.path, n);
      for (const c of data.commits) {
        const refs = c.refs.length ? ` ${Y}(${c.refs.join(", ")})${RESET}` : "";
        console.log(`${G}${c.abbreviatedHash}${RESET}${refs} ${c.subject}  ${C}${c.authorName}${RESET} ${c.authorDate}`);
      }
    });

  projectOptions(
    git.command("diff").description("Show diff")
  )
    .argument("[ref1]", "Base ref")
    .argument("[ref2]", "Compare ref")
    .action(async (ref1: string | undefined, ref2: string | undefined, opts: { project?: string }) => {
      configService.load();
      const ps = new ProjectService(configService);
      const project = resolveProject(ps, opts.project);
      const svc = await getGitService();
      const diffText = await svc.diff(project.path, ref1, ref2);
      console.log(diffText);
    });

  projectOptions(
    git.command("stage <files...>").description("Stage files")
  ).action(async (files: string[], opts: { project?: string }) => {
    configService.load();
    const ps = new ProjectService(configService);
    const project = resolveProject(ps, opts.project);
    const svc = await getGitService();
    await svc.stage(project.path, files);
    console.log(`${G}Staged:${RESET} ${files.join(", ")}`);
  });

  projectOptions(
    git.command("unstage <files...>").description("Unstage files")
  ).action(async (files: string[], opts: { project?: string }) => {
    configService.load();
    const ps = new ProjectService(configService);
    const project = resolveProject(ps, opts.project);
    const svc = await getGitService();
    await svc.unstage(project.path, files);
    console.log(`${Y}Unstaged:${RESET} ${files.join(", ")}`);
  });

  projectOptions(
    git.command("commit").description("Commit staged changes")
  )
    .requiredOption("-m, --message <msg>", "Commit message")
    .action(async (opts: { project?: string; message: string }) => {
      configService.load();
      const ps = new ProjectService(configService);
      const project = resolveProject(ps, opts.project);
      const svc = await getGitService();
      const hash = await svc.commit(project.path, opts.message);
      console.log(`${G}Committed:${RESET} ${hash}`);
    });

  projectOptions(
    git.command("push").description("Push to remote")
  ).action(async (opts: { project?: string }) => {
    configService.load();
    const ps = new ProjectService(configService);
    const project = resolveProject(ps, opts.project);
    const svc = await getGitService();
    await svc.push(project.path);
    console.log(`${G}Pushed.${RESET}`);
  });

  projectOptions(
    git.command("pull").description("Pull from remote")
  ).action(async (opts: { project?: string }) => {
    configService.load();
    const ps = new ProjectService(configService);
    const project = resolveProject(ps, opts.project);
    const svc = await getGitService();
    await svc.pull(project.path);
    console.log(`${G}Pulled.${RESET}`);
  });

  registerBranchCommands(git);
}

function registerBranchCommands(git: Command): void {
  const branch = git.command("branch").description("Branch management");

  branch
    .command("create <name>")
    .description("Create a new branch")
    .option("-p, --project <name>", "Project name or path")
    .option("--from <ref>", "Base ref (default: HEAD)")
    .action(async (name: string, opts: { project?: string; from?: string }) => {
      configService.load();
      const ps = new ProjectService(configService);
      const project = resolveProject(ps, opts.project);
      const svc = await getGitService();
      await svc.createBranch(project.path, name, opts.from);
      console.log(`${G}Created branch:${RESET} ${name}`);
    });

  branch
    .command("checkout <name>")
    .description("Checkout a branch")
    .option("-p, --project <name>", "Project name or path")
    .action(async (name: string, opts: { project?: string }) => {
      configService.load();
      const ps = new ProjectService(configService);
      const project = resolveProject(ps, opts.project);
      const svc = await getGitService();
      await svc.checkout(project.path, name);
      console.log(`${G}Switched to:${RESET} ${name}`);
    });

  branch
    .command("delete <name>")
    .description("Delete a branch")
    .option("-p, --project <name>", "Project name or path")
    .option("--force", "Force delete")
    .action(async (name: string, opts: { project?: string; force?: boolean }) => {
      configService.load();
      const ps = new ProjectService(configService);
      const project = resolveProject(ps, opts.project);
      const svc = await getGitService();
      await svc.deleteBranch(project.path, name, opts.force);
      console.log(`${R}Deleted branch:${RESET} ${name}`);
    });

  branch
    .command("merge <source>")
    .description("Merge a branch into current")
    .option("-p, --project <name>", "Project name or path")
    .action(async (source: string, opts: { project?: string }) => {
      configService.load();
      const ps = new ProjectService(configService);
      const project = resolveProject(ps, opts.project);
      const svc = await getGitService();
      await svc.merge(project.path, source);
      console.log(`${G}Merged:${RESET} ${source}`);
    });
}
