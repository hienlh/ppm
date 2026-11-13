#!/usr/bin/env bun
/**
 * Generate the PPM CLI reference the PPM Assistant reads through its `ppm_cli_reference` tool,
 * from the Commander tree `buildProgram()` builds — the same tree `ppm --help` prints — so the
 * reference cannot drift from the commands, and a group added in any file shows up by itself.
 *
 * Writes the result into the `PPM_CLI_REFERENCE` constant of
 * src/services/assistant/ppm-cli-reference.ts. Nothing is written outside the repository.
 *
 * Usage:
 *   bun scripts/generate-ppm-cli-reference.ts            # print to stdout
 *   bun scripts/generate-ppm-cli-reference.ts --update   # rewrite the constant in the source
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Command, Option, Argument } from "commander";

const ROOT = resolve(import.meta.dir, "..");

const isHidden = (c: Command) => (c as unknown as { _hidden?: boolean })._hidden === true;
const visible = (c: Command) => c.commands.filter((s) => !isHidden(s));
/** A group that also runs by itself (`ppm logs` beside `ppm logs issues`) is a command of its own too. */
const runsItself = (c: Command) => (c as unknown as { _actionHandler?: unknown })._actionHandler != null;

function formatArg(a: Argument): string {
  const name = `${a.name()}${a.variadic ? "..." : ""}`;
  return a.required ? `<${name}>` : `[${name}]`;
}

function formatOption(o: Option): string {
  const req = o.mandatory ? " (required)" : "";
  // A default taken from where the CLI runs (`--project`'s cwd) would make the reference depend
  // on the machine that generated it.
  const value = o.defaultValue === process.cwd() ? "the current directory" : String(o.defaultValue);
  const def = o.defaultValue !== undefined && o.defaultValue !== false ? ` [default: ${value}]` : "";
  return `  ${o.flags} — ${o.description}${req}${def}`;
}

function formatCommand(prefix: string, cmd: Command): string {
  const args = cmd.registeredArguments.map(formatArg);
  let line = [prefix, ...args].join(" ");
  if (cmd.description()) line += `\n  ${cmd.description()}`;
  const opts = cmd.options.filter((o) => !o.hidden);
  if (opts.length) line += `\n${opts.map(formatOption).join("\n")}`;
  return line;
}

/** Every runnable command under `cmd`, depth first, with its full `ppm …` prefix. */
function leaves(cmd: Command, prefix: string): string[] {
  const subs = visible(cmd);
  if (!subs.length) return [formatCommand(prefix, cmd)];
  const own = runsItself(cmd) ? [formatCommand(prefix, cmd)] : [];
  return [...own, ...subs.flatMap((s) => leaves(s, `${prefix} ${s.name()}`))];
}

/** Every runnable command's path (`db driver install`), for the routing table's test. */
export async function cliCommandPaths(): Promise<string[]> {
  const { buildProgram } = await import("../src/index.ts");
  const walk = (c: Command, path: string[]): string[] => {
    const subs = visible(c);
    if (!subs.length) return [path.join(" ")];
    return [...(runsItself(c) ? [path.join(" ")] : []), ...subs.flatMap((s) => walk(s, [...path, s.name()]))];
  };
  return visible(await buildProgram()).flatMap((s) => walk(s, [s.name()]));
}

/** The reference as Markdown: the top-level commands, then one section per command group. */
export async function generatePpmCliReference(): Promise<string> {
  const { buildProgram } = await import("../src/index.ts");
  const program = await buildProgram();
  const top = visible(program);
  const core = top.filter((c) => !visible(c).length);
  const sections: string[] = ["# PPM CLI Reference", "## Core Commands (Server & system management)", "```",
    core.map((c) => formatCommand(`ppm ${c.name()}`, c)).join("\n\n"), "```"];
  for (const group of top.filter((c) => visible(c).length)) {
    sections.push(`## ppm ${group.name()} — ${group.description()}`, "```",
      leaves(group, `ppm ${group.name()}`).join("\n\n"), "```");
  }
  sections.push(`
## Tips
- Use \`--json\` when parsing a command's output
- For git/chat/db commands, always name the project (\`--project <name>\`) or the connection`);
  return sections.join("\n");
}

// ── Source code update ──────────────────────────────────────────────────

export const REFERENCE_SOURCE_PATH = join(ROOT, "src", "services", "assistant", "ppm-cli-reference.ts");
const START_MARKER = "export const PPM_CLI_REFERENCE = `";
const END_MARKER = "\n`;\n";

/** The generated text as it appears inside the source's template literal. */
export function escapeForTemplateLiteral(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

function updateSource(cliRef: string): void {
  const src = readFileSync(REFERENCE_SOURCE_PATH, "utf-8");
  const startIdx = src.indexOf(START_MARKER);
  const afterStart = startIdx + START_MARKER.length;
  const endIdx = startIdx === -1 ? -1 : src.indexOf(END_MARKER, afterStart);
  if (startIdx === -1 || endIdx === -1) {
    console.error(`Could not find the PPM_CLI_REFERENCE literal in ${REFERENCE_SOURCE_PATH}`);
    process.exit(1);
  }
  writeFileSync(REFERENCE_SOURCE_PATH, src.slice(0, afterStart) + escapeForTemplateLiteral(cliRef) + src.slice(endIdx));
  console.log(`Updated: ${REFERENCE_SOURCE_PATH}`);
}

if (import.meta.main) {
  const cliRef = await generatePpmCliReference();
  if (process.argv.slice(2).includes("--update")) updateSource(cliRef);
  else console.log(cliRef);
}
