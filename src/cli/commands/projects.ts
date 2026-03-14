import type { Command } from "commander";
import { configService } from "../../services/config.service.ts";
import { ProjectService } from "../../services/project.service.ts";

function pad(str: string, width: number): string {
  return str.length >= width ? str : str + " ".repeat(width - str.length);
}

export function registerProjectCommands(program: Command): void {
  const projects = program.command("projects").description("Manage projects");

  projects
    .command("list")
    .description("List all registered projects")
    .action(() => {
      configService.load();
      const projectService = new ProjectService(configService);
      const list = projectService.list();

      if (list.length === 0) {
        console.log("No projects registered. Run `ppm projects add <path>`.");
        return;
      }

      const nameW = Math.max(4, ...list.map((p) => p.name.length));
      const pathW = Math.max(4, ...list.map((p) => p.path.length));

      console.log(`${pad("NAME", nameW)}  ${pad("PATH", pathW)}  GIT`);
      console.log(`${"-".repeat(nameW)}  ${"-".repeat(pathW)}  ---`);
      for (const p of list) {
        const git = p.hasGit ? "yes" : "no";
        console.log(`${pad(p.name, nameW)}  ${pad(p.path, pathW)}  ${git}`);
      }
    });

  projects
    .command("add <path>")
    .description("Add a project by path")
    .option("-n, --name <name>", "Project name (default: directory basename)")
    .action((path: string, options: { name?: string }) => {
      configService.load();
      const projectService = new ProjectService(configService);
      try {
        projectService.add(path, options.name);
        console.log(`Project added: ${options.name ?? path}`);
      } catch (err) {
        console.error(`Error: ${err}`);
        process.exit(1);
      }
    });

  projects
    .command("remove <name-or-path>")
    .description("Remove a project by name or path")
    .action((nameOrPath: string) => {
      configService.load();
      const projectService = new ProjectService(configService);
      try {
        projectService.remove(nameOrPath);
        console.log(`Project removed: ${nameOrPath}`);
      } catch (err) {
        console.error(`Error: ${err}`);
        process.exit(1);
      }
    });
}
