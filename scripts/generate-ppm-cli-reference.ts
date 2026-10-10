#!/usr/bin/env bun
/**
 * Generate the PPM CLI reference the PPM Assistant reads through its `ppm_cli_reference` tool,
 * from the Commander.js source itself, so the reference cannot drift from the commands.
 *
 * Parses src/index.ts + src/cli/commands/*.ts for every command, description, option and
 * argument, and writes the result into the `PPM_CLI_REFERENCE` constant of
 * src/services/assistant/ppm-cli-reference.ts. Nothing is written outside the repository.
 *
 * Usage:
 *   bun scripts/generate-ppm-cli-reference.ts            # print to stdout
 *   bun scripts/generate-ppm-cli-reference.ts --update   # rewrite the constant in the source
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const INDEX_PATH = join(ROOT, "src", "index.ts");
const CMD_DIR = join(ROOT, "src", "cli", "commands");

// ── Types ──────────────────────────────────────────────────────────────

interface CliOption {
  flags: string;
  description: string;
  defaultValue?: string;
  required?: boolean;
}

interface CliCommand {
  /** Full display name including parent path, e.g. "branch create" */
  displayName: string;
  description: string;
  args: string[];
  options: CliOption[];
}

interface CommandGroup {
  name: string;
  description: string;
  commands: CliCommand[];
}

// ── Parsing ────────────────────────────────────────────────────────────

/** Extract first quoted string from a regex match, handling mixed quote types */
function extractQuoted(line: string, after: string): string | null {
  const idx = line.indexOf(after);
  if (idx === -1) return null;
  const rest = line.slice(idx + after.length);

  // Match opening quote, then capture until same closing quote
  const m = rest.match(/["'`]((?:[^"'`\\]|\\.)*)["'`]/);
  return m ? m[1]! : null;
}

/** Extract string argument from .description("...") — handles embedded quotes */
function extractDescription(line: string): string | null {
  // Try specific patterns: .description("..."), .description('...')
  const dblMatch = line.match(/\.description\(\s*"([^"]*)"\s*\)/);
  if (dblMatch) return dblMatch[1]!;

  const sglMatch = line.match(/\.description\(\s*'([^']*)'\s*\)/);
  if (sglMatch) return sglMatch[1]!;

  const btMatch = line.match(/\.description\(\s*`([^`]*)`\s*\)/);
  if (btMatch) return btMatch[1]!;

  return null;
}

/**
 * Parse a Commander.js source file into commands.
 * Tracks variable assignments to resolve nested groups:
 *   const branch = git.command("branch")  →  branch.command("create") is "branch create"
 *
 * Handles multi-line chaining where receiver is on previous line:
 *   branch
 *     .command("create <name>")
 */
function parseFile(filePath: string): CliCommand[] {
  const src = readFileSync(filePath, "utf-8");
  const lines = src.split("\n");
  const commands: CliCommand[] = [];

  // Track variable → parent path mapping
  // e.g. "git" → "", "branch" → "branch", "mem" → "memory"
  const varParent = new Map<string, string>();

  // Track function parameters as potential receivers: function xxx(param: Command)
  for (const line of lines) {
    const funcParamMatch = line.match(
      /function\s+\w+\(\s*(\w+)\s*:\s*Command\s*\)/,
    );
    if (funcParamMatch) {
      varParent.set(funcParamMatch[1]!, "");
    }
  }

  /** Last standalone variable seen (for multi-line chaining: `branch\n  .command(...)`) */
  let lastStandaloneVar = "";

  let currentCmd: {
    displayName: string;
    description: string;
    args: string[];
    options: CliOption[];
  } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Track standalone variable references (for multi-line chaining)
    const standaloneMatch = line.match(/^\s+(\w+)\s*$/);
    if (standaloneMatch) {
      lastStandaloneVar = standaloneMatch[1]!;
    }

    // Detect variable assignment: const/let varName = something.command("name")
    const assignMatch = line.match(
      /(?:const|let)\s+(\w+)\s*=\s*(\w+)\.command\(\s*["'`](\w+)["'`]\s*\)/,
    );
    if (assignMatch) {
      const varName = assignMatch[1]!;
      const receiver = assignMatch[2]!;
      const cmdName = assignMatch[3]!;

      // If this creates a known CLI group (git, bot, etc.), its path stays ""
      // because formatCommand already prepends "ppm <group>"
      if (cmdName in GROUP_MAP) {
        varParent.set(varName, "");
      } else {
        const parentPath = varParent.get(receiver);
        if (parentPath !== undefined) {
          varParent.set(varName, parentPath ? `${parentPath} ${cmdName}` : cmdName);
        } else {
          varParent.set(varName, "");
        }
      }
      continue;
    }

    // Detect chained .command("name") — not an assignment
    const cmdMatch = line.match(/\.command\(\s*["'`]([^"'`]+)["'`]\s*\)/);
    if (cmdMatch) {
      // Save previous command
      if (currentCmd) {
        commands.push({ ...currentCmd });
      }

      const fullArg = cmdMatch[1]!;
      const parts = fullArg.split(/\s+/);
      const name = parts[0]!;
      const args = parts.slice(1);

      // Determine receiver: same line or previous line (multi-line chaining)
      const sameLineReceiver = line.match(/(\w+)\.command\(/);
      let receiver = sameLineReceiver ? sameLineReceiver[1]! : "";

      // If receiver looks like a keyword (not a variable), try lastStandaloneVar
      if (!receiver || receiver === "command") {
        // .command() at start of line → look at previous non-empty line
        receiver = lastStandaloneVar;
      }

      const parentPath = varParent.get(receiver) ?? "";
      const displayName = parentPath ? `${parentPath} ${name}` : name;

      currentCmd = { displayName, description: "", args, options: [] };
      lastStandaloneVar = "";
      continue;
    }

    if (!currentCmd) continue;

    // Description
    const desc = extractDescription(line);
    if (desc !== null && line.includes(".description(")) {
      currentCmd.description = desc;
    }

    // Option: .option("flags", "desc", "default?")
    const optMatch = line.match(
      /\.option\(\s*["'`]([^"'`]+)["'`]\s*,\s*["'`]([^"'`]+)["'`](?:\s*,\s*["'`]([^"'`]+)["'`])?\s*\)/,
    );
    if (optMatch) {
      currentCmd.options.push({
        flags: optMatch[1]!,
        description: optMatch[2]!,
        defaultValue: optMatch[3],
      });
    }

    // Required option
    const reqMatch = line.match(
      /\.requiredOption\(\s*["'`]([^"'`]+)["'`]\s*,\s*["'`]([^"'`]+)["'`](?:\s*,\s*["'`]([^"'`]+)["'`])?\s*\)/,
    );
    if (reqMatch) {
      currentCmd.options.push({
        flags: reqMatch[1]!,
        description: reqMatch[2]!,
        defaultValue: reqMatch[3],
        required: true,
      });
    }

    // Argument: .argument("name")
    const argMatch = line.match(/\.argument\(\s*["'`]([^"'`]+)["'`]/);
    if (argMatch) {
      currentCmd.args.push(argMatch[1]!);
    }
  }

  // Push last command
  if (currentCmd) {
    commands.push({ ...currentCmd });
  }

  return commands;
}

/** Known command groups with their source files */
const GROUP_MAP: Record<string, { description: string; file: string }> = {
  projects: { description: "Manage registered projects", file: "projects.ts" },
  config: { description: "Configuration management", file: "config-cmd.ts" },
  git: { description: "Git operations for a project", file: "git-cmd.ts" },
  chat: { description: "AI chat sessions", file: "chat-cmd.ts" },
  db: { description: "Database connections & queries", file: "db-cmd.ts" },
  autostart: { description: "Auto-start on boot", file: "autostart.ts" },
  cloud: { description: "PPM Cloud — device registry + tunnel", file: "cloud.ts" },
  ext: { description: "Manage PPM extensions", file: "ext-cmd.ts" },
  schedule: { description: "Scheduled agents (cron)", file: "schedule-cmd.ts" },
  // `ppm bot` is left out on purpose: its coordinator is not the Assistant's way of working.
  bot: { description: "", file: "" },
};

/** Groups parsed only to keep their commands out of the core list. */
const OMITTED_GROUPS = new Set(["bot"]);

function buildGroups(): CommandGroup[] {
  const groups: CommandGroup[] = [];

  // Top-level commands from index.ts
  const indexCmds = parseFile(INDEX_PATH);
  const groupNames = new Set(Object.keys(GROUP_MAP));
  const topLevel = indexCmds.filter((c) => !groupNames.has(c.displayName));

  if (topLevel.length > 0) {
    groups.push({
      name: "core",
      description: "Server & system management",
      commands: topLevel,
    });
  }

  // Sub-command groups from individual files
  for (const [groupName, info] of Object.entries(GROUP_MAP)) {
    if (OMITTED_GROUPS.has(groupName)) continue;
    const filePath = join(CMD_DIR, info.file);
    if (!existsSync(filePath)) continue;

    const cmds = parseFile(filePath);

    // Filter out the group parent command and pure sub-group declarations
    // (e.g. "branch" with no description = just a group container)
    const subCmds = cmds.filter((c) => {
      if (c.displayName === groupName) return false;
      // Skip pure group containers (no description, no args)
      if (!c.description && c.args.length === 0 && c.options.length === 0) return false;
      return true;
    });

    groups.push({
      name: groupName,
      description: info.description,
      commands: subCmds,
    });
  }

  return groups;
}

// ── Output Generation ──────────────────────────────────────────────────

function formatOption(opt: CliOption): string {
  const req = opt.required ? " (required)" : "";
  const def = opt.defaultValue ? ` [default: ${opt.defaultValue}]` : "";
  return `  ${opt.flags} — ${opt.description}${req}${def}`;
}

function formatCommand(group: string, cmd: CliCommand): string {
  const args = cmd.args.length > 0 ? " " + cmd.args.join(" ") : "";
  const prefix = group === "core" ? "ppm" : `ppm ${group}`;
  let line = `${prefix} ${cmd.displayName}${args}`;
  if (cmd.description) line += `\n  ${cmd.description}`;
  if (cmd.options.length > 0) {
    line += "\n" + cmd.options.map(formatOption).join("\n");
  }
  return line;
}

/** The reference as Markdown: one section per command group. */
export function generatePpmCliReference(): string {
  const sections: string[] = [`# PPM CLI Reference`];
  for (const group of buildGroups()) {
    sections.push(group.name === "core"
      ? `## Core Commands (${group.description})`
      : `## ppm ${group.name} — ${group.description}`);
    sections.push("```");
    sections.push(group.commands.map((c) => formatCommand(group.name, c)).join("\n\n"));
    sections.push("```");
  }
  sections.push(`
## Tips
- Use \`--json\` when parsing a command's output
- For git/chat/db commands, always name the project (\`--project <name>\`) or the connection`);
  return sections.join("\n");
}

// ── Source Code Update ────────────────────────────────────────────────

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

// ── Main ───────────────────────────────────────────────────────────────

if (import.meta.main) {
  const cliRef = generatePpmCliReference();
  if (process.argv.slice(2).includes("--update")) updateSource(cliRef);
  else console.log(cliRef);
}
