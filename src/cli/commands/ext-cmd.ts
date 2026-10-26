import { Command } from "commander";
import { markMachineFacing } from "../utils/machine-facing-commands.ts";

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
  const headerLine = headers.map((h, i) => ` ${h.padEnd(colWidths[i]!)} `).join("|");
  console.log(`+${sep}+`);
  console.log(`|${C.bold}${headerLine}${C.reset}|`);
  console.log(`+${sep}+`);
  for (const row of rows) {
    const line = row.map((cell, i) => ` ${(cell ?? "").padEnd(colWidths[i]!)} `).join("|");
    console.log(`|${line}|`);
  }
  console.log(`+${sep}+`);
}

export function registerExtCommands(program: Command): void {
  const ext = program.command("ext").description("Manage PPM extensions");

  ext
    .command("install <name>")
    .description("Install an extension from npm")
    .action(async (name: string) => {
      const { extensionService } = await import("../../services/extension.service.ts");
      try {
        console.log(`${C.dim}Installing ${name}...${C.reset}`);
        const manifest = await extensionService.install(name);
        console.log(`${C.green}✓${C.reset} Installed ${C.bold}${manifest.id}${C.reset}@${manifest.version}`);
      } catch (e) {
        console.error(`${C.red}✗${C.reset} ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });

  ext
    .command("remove <name>")
    .description("Remove an installed extension")
    .action(async (name: string) => {
      const { extensionService } = await import("../../services/extension.service.ts");
      try {
        await extensionService.remove(name);
        console.log(`${C.green}✓${C.reset} Removed ${C.bold}${name}${C.reset}`);
      } catch (e) {
        console.error(`${C.red}✗${C.reset} ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });

  ext
    .command("list")
    .description("List installed extensions")
    .action(async () => {
      const { extensionService } = await import("../../services/extension.service.ts");
      await extensionService.discover(); // populate bundledIds for source column
      const extensions = extensionService.list();
      if (extensions.length === 0) {
        console.log(`${C.dim}No extensions installed.${C.reset}`);
        return;
      }
      const rows = extensions.map((e) => [
        e.id,
        e.version,
        extensionService.isBundled(e.id) ? `${C.cyan}bundled${C.reset}` : "user",
        e.enabled ? `${C.green}enabled${C.reset}` : `${C.dim}disabled${C.reset}`,
        e.activated ? `${C.green}active${C.reset}` : `${C.dim}inactive${C.reset}`,
      ]);
      printTable(["ID", "Version", "Source", "Enabled", "Status"], rows);
    });

  ext
    .command("enable <name>")
    .description("Enable an extension")
    .action(async (name: string) => {
      const { extensionService } = await import("../../services/extension.service.ts");
      try {
        await extensionService.setEnabled(name, true);
        console.log(`${C.green}✓${C.reset} Enabled ${C.bold}${name}${C.reset}`);
      } catch (e) {
        console.error(`${C.red}✗${C.reset} ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });

  ext
    .command("disable <name>")
    .description("Disable an extension")
    .action(async (name: string) => {
      const { extensionService } = await import("../../services/extension.service.ts");
      try {
        await extensionService.setEnabled(name, false);
        console.log(`${C.green}✓${C.reset} Disabled ${C.bold}${name}${C.reset}`);
      } catch (e) {
        console.error(`${C.red}✗${C.reset} ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });

  // Every token but --json and --timeout reaches the handler as its own argument:
  // `handler(...args)`. Put them after `--` to pass those two through as well.
  const run = ext
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
  markMachineFacing(run);

  ext
    .command("dev <path>")
    .description("Symlink a local extension for development")
    .action(async (localPath: string) => {
      const { extensionService } = await import("../../services/extension.service.ts");
      try {
        const manifest = await extensionService.devLink(localPath);
        console.log(`${C.green}✓${C.reset} Dev-linked ${C.bold}${manifest.id}${C.reset} → ${localPath}`);
      } catch (e) {
        console.error(`${C.red}✗${C.reset} ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });
}
