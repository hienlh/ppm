import type { Command } from "commander";
import { isBuiltinCliName } from "../../shared/cli-builtin-commands.ts";
import { EXECUTE_DEFAULT_TIMEOUT_MS } from "../../shared/extension-command-execute.ts";
import type { CliAlias } from "../../services/extension-cli-aliases.ts";
import { markMachineFacing } from "../utils/machine-facing-commands.ts";

/**
 * `ppm <name> [args…]` for every alias an enabled extension contributes (`contributes.cli`).
 *
 * Registered outside `buildProgram()` on purpose: the generated `ppm` skill reads that program,
 * and must never list one user's extensions. Loaded only when the command line could need one,
 * so `ppm start` and every other built-in never touches the extensions table for it.
 */

/** Whether `argv` (process.argv) could name an alias, or asks for the help that lists them. */
export function shouldLoadAliases(argv: readonly string[]): boolean {
  const first = argv[2];
  if (first === undefined) return true;
  if (first === "--help" || first === "-h" || first === "help") return true;
  if (first.startsWith("-")) return false;
  return !isBuiltinCliName(first);
}

export type AliasRunner = (command: string, argv: string[]) => Promise<void>;

async function runAlias(command: string, argv: string[]): Promise<void> {
  const { runExtensionCommand } = await import("../utils/run-extension-command.ts");
  const code = await runExtensionCommand(command, [argv], { printMode: "auto", timeoutMs: EXECUTE_DEFAULT_TIMEOUT_MS });
  process.exit(code);
}

/**
 * Add one command per alias. Every token after the name reaches the handler verbatim, `--json`
 * and `--help` included, as one array argument: `handler(argv: string[])`. That needs Commander's
 * positional options, so the root's own options (`--version`, `--help`) only count before the
 * command name.
 */
export function addExtensionCliAliases(program: Command, aliases: readonly CliAlias[], run: AliasRunner = runAlias): void {
  if (aliases.length === 0) return;
  program.enablePositionalOptions();
  for (const alias of aliases) {
    const command = program
      .command(alias.name)
      .description(alias.description ?? `${alias.extensionId}: ${alias.command}`)
      .helpOption(false)
      .allowUnknownOption()
      .allowExcessArguments()
      .passThroughOptions()
      .argument("[args...]", `passed to ${alias.command}; try --help`)
      .action(async (args: string[] | undefined) => {
        await run(alias.command, args ?? []);
      });
    markMachineFacing(command);
  }
}

/**
 * Read the aliases and register them. A broken manifest or database must never stop a built-in
 * command, so any failure here is swallowed (named on stderr only with `PPM_DEBUG`).
 */
export async function registerExtensionCliAliases(program: Command): Promise<void> {
  try {
    const { readEnabledCliAliases } = await import("../../services/extension-cli-aliases.ts");
    const { aliases, refused } = await readEnabledCliAliases();
    if (process.env.PPM_DEBUG) {
      for (const r of refused) process.stderr.write(`extension CLI alias "${r.name}" from ${r.extensionId} refused: ${r.reason}\n`);
    }
    addExtensionCliAliases(program, aliases);
  } catch (e) {
    if (process.env.PPM_DEBUG) process.stderr.write(`extension CLI aliases not loaded: ${e instanceof Error ? e.message : String(e)}\n`);
  }
}
