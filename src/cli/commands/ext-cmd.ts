import { Command } from "commander";
import { C, run } from "./chat-cmd-request.ts";
import { ppmApiRequest } from "../utils/settings-request.ts";
import { LONG_REQUEST_TIMEOUT_MS } from "../utils/request-progress.ts";
import { printTable } from "./cli-table.ts";
import { markMachineFacing } from "../utils/machine-facing-commands.ts";

/**
 * `ppm ext`: extensions, through `/api/extensions` on the running PPM — so its extension host
 * installs, activates and deactivates them, and every open browser refreshes its palette and views
 * (`extensions:changed`). Only when no PPM holds the database do the routes run here, after the
 * direct-write notice.
 *
 * Installing from npm or linking a local folder may be run from an AI chat: the shell's approval
 * card the user answers is the control for that.
 */

interface ExtensionRow { id: string; version: string; enabled: boolean; activated: boolean; bundled?: boolean }
interface Manifest { id: string; version: string }

const LONG = {
  timeoutMs: LONG_REQUEST_TIMEOUT_MS, progress: true,
  timeoutHint: "PPM keeps installing in the background; check with `ppm ext list`.",
};

/** `/extensions/<id>`, keeping the `/` of a scoped package name (`@scope/name`) as a path separator. */
const extPath = (id: string) => `/extensions/${id.split("/").map(encodeURIComponent).join("/")}`;

export function registerExtCommands(program: Command): void {
  const ext = program.command("ext").description("Manage PPM extensions");

  ext
    .command("install <name>")
    .description("Install an extension from npm (in the running PPM; may take minutes)")
    .action((name: string) => run(async () => {
      console.log(`${C.dim}Installing ${name}...${C.reset}`);
      const manifest = await ppmApiRequest<Manifest>("POST", "/extensions/install", { name }, LONG);
      console.log(`${C.green}✓${C.reset} Installed ${manifest.id}@${manifest.version}`);
    })());

  ext
    .command("remove <name>")
    .description("Remove an installed extension")
    .action((name: string) => run(async () => {
      await ppmApiRequest("DELETE", extPath(name));
      console.log(`${C.green}✓${C.reset} Removed ${name}`);
    })());

  ext
    .command("list")
    .description("List installed extensions")
    .option("--json", "Print JSON")
    .action((opts: { json?: boolean }) => run(async () => {
      const extensions = await ppmApiRequest<ExtensionRow[]>("GET", "/extensions");
      if (opts.json) return void console.log(JSON.stringify(extensions, null, 2));
      if (extensions.length === 0) return void console.log(`${C.dim}No extensions installed.${C.reset}`);
      printTable(["ID", "Version", "Source", "Enabled", "Status"], extensions.map((e) => [
        e.id, e.version, e.bundled ? "bundled" : "user",
        e.enabled ? "enabled" : "disabled", e.activated ? "active" : "inactive",
      ]));
    })());

  for (const [verb, enabled] of [["enable", true], ["disable", false]] as const) {
    ext
      .command(`${verb} <name>`)
      .description(`${enabled ? "Enable" : "Disable"} an extension (its commands ${enabled ? "join" : "leave"} every open palette)`)
      .action((name: string) => run(async () => {
        await ppmApiRequest("PATCH", extPath(name), { enabled }, { timeoutMs: 120_000 });
        console.log(`${C.green}✓${C.reset} ${enabled ? "Enabled" : "Disabled"} ${name}`);
      })());
  }

  // Every token but --json and --timeout reaches the handler as its own argument:
  // `handler(...args)`. Put them after `--` to pass those two through as well.
  const runCommand = ext
    .command("run")
    .description("Run a command an extension declared, on the running server")
    .argument("[command]", "command id, as in the extension's contributes.commands")
    .argument("[args...]", "passed to the command as separate arguments")
    .option("--json", "print the result as one line of JSON")
    // Optional value, so a missing one reaches the usage check (exit 2) instead of Commander.
    .option("--timeout [ms]", "how long to wait for the command, in ms (1000 to 600000)")
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async (_command: unknown, _args: unknown, _opts: unknown, self: Command) => {
      // Read from the tokens as typed, so `--` behaves the same wherever it appears.
      const { parseExtRunTokens, rawTokensAfter } = await import("../utils/raw-command-tokens.ts");
      const parsed = parseExtRunTokens(rawTokensAfter(self, ["ext", "run"]));
      const usageError = (message: string): never => {
        process.stderr.write(`${message}\n`);
        process.exit(2);
      };
      if (parsed.error) usageError(parsed.error);
      if (!parsed.command) usageError("Usage: ppm ext run [--json] [--timeout <ms>] <command> [args...]");
      const { clampExecuteTimeout, EXECUTE_DEFAULT_TIMEOUT_MS } = await import("../../shared/extension-command-execute.ts");
      let timeoutMs = EXECUTE_DEFAULT_TIMEOUT_MS;
      if (parsed.timeout !== undefined) {
        if (!/^\d+$/.test(parsed.timeout)) usageError(`--timeout must be a whole number of milliseconds, not "${parsed.timeout}"`);
        timeoutMs = clampExecuteTimeout(Number(parsed.timeout));
      }
      const { runExtensionCommand } = await import("../utils/run-extension-command.ts");
      process.exit(await runExtensionCommand(parsed.command!, parsed.args, { printMode: parsed.json ? "json" : "auto", timeoutMs }));
    });
  markMachineFacing(runCommand);

  ext
    .command("dev <path>")
    .description("Symlink a local extension for development")
    .action((localPath: string) => run(async () => {
      const { resolve } = await import("node:path");
      const absolute = resolve(localPath);
      const manifest = await ppmApiRequest<Manifest>("POST", "/extensions/dev-link", { path: absolute }, LONG);
      console.log(`${C.green}✓${C.reset} Dev-linked ${manifest.id} → ${absolute}`);
    })());
}
