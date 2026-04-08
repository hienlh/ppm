#!/usr/bin/env bun
/**
 * Auto-generate PPMBot coordinator identity from Commander.js CLI source.
 *
 * Parses src/index.ts + src/cli/commands/*.ts to extract all commands,
 * descriptions, options, and arguments. Produces coordinator.md content
 * with full CLI reference, decision framework, and safety rules.
 *
 * Usage:
 *   bun scripts/generate-bot-coordinator.ts              # print to stdout
 *   bun scripts/generate-bot-coordinator.ts --update      # write coordinator.md + update source
 *   bun scripts/generate-bot-coordinator.ts --write-md    # only write ~/.ppm/bot/coordinator.md
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

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
  bot: { description: "PPMBot coordinator utilities", file: "bot-cmd.ts" },
};

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

/** Generate CLI-only reference (for cli-reference.md) */
function generateCliReference(groups: CommandGroup[]): string {
  const sections: string[] = [];
  sections.push(`# PPM CLI Reference`);

  for (const group of groups) {
    const heading = group.name === "core"
      ? `## Core Commands (${group.description})`
      : `## ppm ${group.name} — ${group.description}`;
    sections.push(heading);

    const cmdLines = group.commands.map((c) => formatCommand(group.name, c));
    sections.push("```");
    sections.push(cmdLines.join("\n\n"));
    sections.push("```");
  }

  sections.push(`
## Quick Reference — Task Delegation
\`\`\`
ppm bot delegate --chat <chatId> --project <name> --prompt "<enriched task>"
ppm bot task-status <id>
ppm bot task-result <id>
ppm bot tasks
\`\`\`

## Quick Reference — Memory
\`\`\`
ppm bot memory save "<content>" -c <category>
ppm bot memory list
ppm bot memory forget "<topic>"
\`\`\`

## Tips
- Use \`--json\` flag when parsing command output programmatically
- For git/chat/db operations: always specify \`--project <name>\` or connection name`);

  return sections.join("\n");
}

// ── Source Code Update ────────────────────────────────────────────────

const CLI_DEFAULT_PATH = join(ROOT, "src", "services", "ppmbot", "cli-reference-default.ts");

function updateBundledDefault(cliRef: string): void {
  const escaped = cliRef
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, "\\${");

  const src = readFileSync(CLI_DEFAULT_PATH, "utf-8");
  const startMarker = "export const DEFAULT_CLI_REFERENCE = `";
  const startIdx = src.indexOf(startMarker);
  if (startIdx === -1) {
    console.error("Could not find DEFAULT_CLI_REFERENCE in cli-reference-default.ts");
    process.exit(1);
  }

  const afterStart = startIdx + startMarker.length;
  const endIdx = src.indexOf("\n`;\n", afterStart);
  if (endIdx === -1) {
    console.error("Could not find closing backtick for DEFAULT_CLI_REFERENCE");
    process.exit(1);
  }

  const updated = src.slice(0, afterStart) + escaped + src.slice(endIdx);
  writeFileSync(CLI_DEFAULT_PATH, updated);
  console.log(`Updated: ${CLI_DEFAULT_PATH}`);
}

function writeCliReferenceMd(cliRef: string): void {
  const dir = join(homedir(), ".ppm", "bot");
  mkdirSync(dir, { recursive: true });
  const cliRefPath = join(dir, "cli-reference.md");
  // Read version from package.json
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
  writeFileSync(cliRefPath, `<!-- ppm-version: ${pkg.version} -->\n${cliRef}`);
  console.log(`Written: ${cliRefPath}`);
}

// ── Main ───────────────────────────────────────────────────────────────

const cliArgs = process.argv.slice(2);
const groups = buildGroups();
const cliRef = generateCliReference(groups);

if (cliArgs.includes("--cli-only")) {
  // Runtime mode: just output CLI reference to stdout (used by ensureCliReference)
  console.log(cliRef);
} else if (cliArgs.includes("--update")) {
  // Dev mode: write cli-reference.md + update bundled default
  writeCliReferenceMd(cliRef);
  updateBundledDefault(cliRef);
  console.log("\nDone. Review the changes and test with PPMBot.");
} else if (cliArgs.includes("--write-md")) {
  writeCliReferenceMd(cliRef);
} else {
  // Default: stdout
  console.log(cliRef);
}
