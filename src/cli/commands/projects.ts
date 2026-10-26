import { Command } from "commander";
import { resolve } from "node:path";

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
};

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
    .action(async () => {
      try {
        const { projectService } = await import("../../services/project.service.ts");
        const { gitService } = await import("../../services/git.service.ts");
        const { configService } = await import("../../services/config.service.ts");
        // list() reads the in-memory config, which is empty until loaded.
        configService.load();
        const list = projectService.list();

        if (list.length === 0) {
          console.log(`${C.yellow}No projects registered.${C.reset} Run: ppm init`);
          return;
        }

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
    .description("Add a project to the registry")
    .option("-n, --name <name>", "Project name (defaults to folder name)")
    .action(async (projectPath: string, options: { name?: string }) => {
      try {
        const body = { path: resolve(projectPath), ...(options.name ? { name: options.name } : {}) };
        const viaServer = await throughRunningServer<{ name: string; path: string }>("POST", "/api/projects", body);
        const entry = viaServer ?? await (async () => {
          const { projectService } = await import("../../services/project.service.ts");
          const { configService } = await import("../../services/config.service.ts");
          configService.load();
          return projectService.add(projectPath, options.name);
        })();
        console.log(`${C.green}Added project:${C.reset} ${entry.name} → ${entry.path}`);
      } catch (err) {
        console.error(`${C.red}Error:${C.reset}`, (err as Error).message);
        process.exit(1);
      }
    });

  projects
    .command("remove <name>")
    .description("Remove a project from the registry")
    .action(async (nameOrPath: string) => {
      try {
        // A path is resolved here: the server would resolve it against its own working directory.
        const target = /[\\/]/.test(nameOrPath) || nameOrPath === "." || nameOrPath === ".." ? resolve(nameOrPath) : nameOrPath;
        const viaServer = await throughRunningServer("DELETE", `/api/projects/${encodeURIComponent(target)}`);
        if (viaServer === null) {
          const { projectService } = await import("../../services/project.service.ts");
          const { configService } = await import("../../services/config.service.ts");
          configService.load();
          projectService.remove(nameOrPath);
        }
        console.log(`${C.green}Removed project:${C.reset} ${nameOrPath}`);
      } catch (err) {
        console.error(`${C.red}Error:${C.reset}`, (err as Error).message);
        process.exit(1);
      }
    });
}

/**
 * Change the project list through the running server when there is one: it keeps projects in
 * memory, so a write straight to the database would stay invisible to it until a restart.
 * Null when no server is running, so the caller writes the database itself. The server's own
 * refusal (a duplicate, a missing path) is thrown with its message.
 */
async function throughRunningServer<T = unknown>(method: "POST" | "DELETE", path: string, body?: unknown): Promise<T | null> {
  const { callServer, ServerDownError } = await import("../utils/server-client.ts");
  try {
    return await callServer<T>(method, path, body);
  } catch (e) {
    if (e instanceof ServerDownError) return null;
    throw e;
  }
}
