import type { Command } from "commander";
import { C, projectNameOf, run } from "./chat-cmd-request.ts";
import { ppmApiRequest } from "../utils/settings-request.ts";
import { projectRequest } from "../utils/project-route.ts";
import { LONG_REQUEST_TIMEOUT_MS } from "../utils/request-progress.ts";
import { printTable } from "./cli-table.ts";

/**
 * `ppm lsp`: the editor's language servers, through the routes Settings → Language servers and the
 * editor's Install button call. A server is named by its **id** (`ppm lsp list`), never by a package:
 * the packages are PPM's registry's. `install -p <project>` installs for that project (a rustup
 * component lands in the toolchain the project selects); without it, machine-wide.
 */

interface ServerRow {
  id: string; displayName: string; languages: string[]; installed: boolean; installable: boolean;
  installHint: string; origin?: string; removable: boolean; alsoRemoves?: string[];
}
interface ServersAnswer { servers: ServerRow[]; installDir: string; running: Array<{ serverId?: string; rootPath?: string }> }

const LONG = {
  timeoutMs: LONG_REQUEST_TIMEOUT_MS, progress: true,
  timeoutHint: "PPM keeps installing in the background; check with `ppm lsp list`.",
};

function stateOf(s: ServerRow): string {
  if (s.installed) return s.origin ? `installed (${s.origin})` : "installed";
  return s.installable ? "not installed" : "not installed (manual)";
}

export function registerLspCommands(program: Command): void {
  const lsp = program.command("lsp").description("Language servers for the editor: list, install, remove");

  lsp
    .command("list")
    .description("List the language servers PPM knows, and whether this machine has each")
    .option("--json", "Print JSON")
    .action((opts: { json?: boolean }) => run(async () => {
      const answer = await ppmApiRequest<ServersAnswer>("GET", "/lsp/servers", undefined, { timeoutMs: 60_000 });
      if (opts.json) return void console.log(JSON.stringify(answer, null, 2));
      printTable(["ID", "Server", "Languages", "State"], answer.servers.map((s) => [s.id, s.displayName, s.languages.join(", "), stateOf(s)]));
      console.log(`${C.dim}Installs go to ${answer.installDir}${C.reset}`);
    })());

  lsp
    .command("install <id>")
    .description("Install a language server by its id (may take minutes)")
    .option("-p, --project <name>", "Install for this project (its toolchain), not machine-wide")
    .action((id: string, opts: { project?: string }) => run(async () => {
      console.log(`${C.dim}Installing ${id}...${C.reset}`);
      const done = opts.project
        ? await projectRequest<{ displayName: string }>("POST", await projectNameOf(opts.project), "/lsp/install", { serverId: id }, LONG)
        : await ppmApiRequest<{ displayName: string }>("POST", "/lsp/install", { serverId: id }, LONG);
      console.log(`${C.green}✓${C.reset} Installed ${done.displayName}. Open files using it reconnect by themselves.`);
    })());

  lsp
    .command("remove <id>")
    .description("Remove a language server PPM installed (one on PATH or in a project is left alone)")
    .action((id: string) => run(async () => {
      const done = await ppmApiRequest<{ displayName: string }>("POST", "/lsp/uninstall", { serverId: id }, { timeoutMs: 120_000 });
      console.log(`${C.green}✓${C.reset} Removed ${done.displayName}.`);
    })());
}
