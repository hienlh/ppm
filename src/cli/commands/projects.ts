import { Command } from "commander";
import { resolve } from "node:path";
import { C, fail, projectNameFor, projectSub, projectsRequest, refuseFolderFromAiChat } from "./projects-cmd-request.ts";
import { registerProjectEditCommands } from "./projects-cmd-edit.ts";

function printTable(headers: string[], rows: string[][]): void {
  const colWidths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );

  const sep = colWidths.map((w) => "-".repeat(w + 2)).join("+");
  const headerLine = headers
    .map((h, i) => ` ${h.padEnd(colWidths[i]!)} `)
    .join("|");

  console.log(`+${sep}+`);
  console.log(`|${C.bold}${headerLine}${C.reset}|`);
  console.log(`+${sep}+`);
  for (const row of rows) {
    const line = row.map((cell, i) => ` ${(cell ?? "").padEnd(colWidths[i]!)} `).join("|");
    console.log(`|${line}|`);
  }
  console.log(`+${sep}+`);
}

export function registerProjectsCommands(program: Command): void {
  const projects = program.command("projects").description("Manage registered projects");

  projects
    .command("list")
    .description("List all registered projects")
    .option("--json", "Output as JSON")
    .action(async (options: { json?: boolean }) => {
      try {
        const { projectService } = await import("../../services/project.service.ts");
        const { configService } = await import("../../services/config.service.ts");
        // A fresh process holds only the defaults (no projects) until it reads the database.
        configService.load();
        const list = projectService.list();

        if (options.json) {
          console.log(JSON.stringify(list.map((p) => ({ name: p.name, path: p.path })), null, 2));
          return;
        }
        if (list.length === 0) {
          console.log(`${C.yellow}No projects registered.${C.reset} Run: ppm init`);
          return;
        }

        const { gitService } = await import("../../services/git.service.ts");
        const rows: string[][] = [];
        for (const p of list) {
          let branch = "-";
          let status = "-";
          try {
            const s = await gitService.status(p.path);
            branch = s.current ?? "-";
            const dirty = s.staged.length + s.unstaged.length + s.untracked.length;
            status = dirty > 0 ? `${C.yellow}dirty${C.reset}` : `${C.green}clean${C.reset}`;
          } catch {
            status = `${C.dim}no git${C.reset}`;
          }
          rows.push([p.name, p.path, branch, status]);
        }

        printTable(["Name", "Path", "Branch", "Status"], rows);
      } catch (err) {
        console.error(`${C.red}Error:${C.reset}`, (err as Error).message);
        process.exit(1);
      }
    });

  projects
    .command("add <path>")
    .description("Add a project to the registry, through the running PPM when one holds the database")
    .option("-n, --name <name>", "Project name (defaults to folder name)")
    .action(async (projectPath: string, options: { name?: string }) => {
      // Resolved here: the server's working directory is not this shell's.
      const abs = resolve(projectPath);
      await refuseFolderFromAiChat(abs, "added");
      try {
        const entry = await projectsRequest<{ name: string; path: string }>("POST", "", { path: abs, ...(options.name ? { name: options.name } : {}) });
        console.log(`${C.green}Added project:${C.reset} ${entry.name} → ${entry.path}`);
      } catch (err) {
        fail((err as Error).message);
      }
    });

  projects
    .command("remove <name>")
    .description("Remove a project from the registry (by name or folder); its files stay on disk")
    .action(async (nameOrPath: string) => {
      try {
        const name = await projectNameFor(nameOrPath);
        await projectsRequest("DELETE", projectSub(name));
        console.log(`${C.green}Removed project:${C.reset} ${name}`);
      } catch (err) {
        fail((err as Error).message);
      }
    });

  registerProjectEditCommands(projects);
}
