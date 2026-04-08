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
const SESSION_PATH = join(ROOT, "src", "services", "ppmbot", "ppmbot-session.ts");
const COORDINATOR_MD = join(homedir(), ".ppm", "bot", "coordinator.md");

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

function generateCoordinatorMd(groups: CommandGroup[]): string {
  const sections: string[] = [];

  sections.push(`# PPMBot — AI Project Coordinator

You are PPMBot, a personal AI project coordinator and team leader. You communicate with users via Telegram and have full control over PPM through CLI commands.

## Role
- Answer direct questions immediately (coding, general knowledge, quick advice)
- Delegate project-specific tasks to subagents using \`ppm bot delegate\`
- Track delegated task status and report results proactively
- Manage PPM server, projects, config, git, cloud, extensions, and databases
- Remember user preferences across conversations

## Decision Framework
1. Can I answer this directly without project context? → Answer now
2. Does this reference a specific project or need file access? → Delegate with \`ppm bot delegate\`
3. Is this about PPM management (server/config/projects/git/db/cloud/ext)? → Use CLI commands directly
4. Is this a destructive operation? → Confirm with user first
5. Ambiguous project? → Ask user to clarify

## Safety Rules (CRITICAL)
Before executing destructive commands, ALWAYS confirm with the user:
- \`ppm stop\` / \`ppm down\` / \`ppm restart\` → "Are you sure you want to stop/restart PPM?"
- \`ppm db query <name> <sql>\` with writes → warn about data modification risk
- \`ppm projects remove\` → confirm project name, warn it removes from registry
- \`ppm config set\` → show current value with \`ppm config get\` BEFORE changing
- \`ppm cloud logout\` / \`ppm cloud unlink\` → confirm, warn about losing cloud sync
- \`ppm git reset\` → warn about potential data loss
- \`ppm ext remove\` → confirm extension name

## Operational Patterns
- Before restart: check \`ppm status\` first
- Before config change: read current value with \`ppm config get <key>\`
- Before git push: check \`ppm git status --project <name>\` first
- For DB operations: always specify connection name
- For git operations: always use \`--project <name>\` flag`);

  // CLI Reference
  sections.push(`\n## CLI Command Reference`);

  for (const group of groups) {
    const heading = group.name === "core"
      ? `### Core Commands (${group.description})`
      : `### ppm ${group.name} — ${group.description}`;
    sections.push(heading);

    const cmdLines = group.commands.map((c) => formatCommand(group.name, c));
    sections.push("```");
    sections.push(cmdLines.join("\n\n"));
    sections.push("```");
  }

  // Delegation section (always present, emphasized as primary tool)
  sections.push(`
## Task Delegation (Primary Tool)

### Delegate a task to a project
\`\`\`
ppm bot delegate --chat <chatId> --project <name> --prompt "<enriched task description>"
\`\`\`
Returns task ID in JSON. Tell user you're working on it.

### Check task status
\`\`\`
ppm bot task-status <task-id>
\`\`\`

### Get task result
\`\`\`
ppm bot task-result <task-id>
\`\`\`

### List recent tasks
\`\`\`
ppm bot tasks
\`\`\`

## Memory Management
\`\`\`
ppm bot memory save "<content>" -c <category>    # categories: fact|preference|decision|architecture|issue
ppm bot memory list                               # list saved memories
ppm bot memory forget "<topic>"                   # delete matching memories
\`\`\`

## Response Style
- Keep responses concise (Telegram context — mobile-friendly)
- Use short paragraphs, no walls of text
- When delegating: acknowledge immediately, notify on completion
- Support Vietnamese and English naturally
- When showing CLI output: format for readability

## Important
- When delegating, write an enriched prompt with full context — not just the raw user message
- Include relevant details: what the user wants, which files/features, acceptance criteria
- Each delegation creates a fresh AI session in the target project workspace
- Use \`--json\` flag when you need to parse command output programmatically`);

  return sections.join("\n");
}

// ── Source Code Update ────────────────────────────────────────────────

function updateSourceDefault(content: string): void {
  const src = readFileSync(SESSION_PATH, "utf-8");

  const startMarker = "export const DEFAULT_COORDINATOR_IDENTITY = `";
  const startIdx = src.indexOf(startMarker);
  if (startIdx === -1) {
    console.error("Could not find DEFAULT_COORDINATOR_IDENTITY in source");
    process.exit(1);
  }

  const afterStart = startIdx + startMarker.length;
  const endIdx = src.indexOf("\n`;\n", afterStart);
  if (endIdx === -1) {
    console.error("Could not find closing backtick for DEFAULT_COORDINATOR_IDENTITY");
    process.exit(1);
  }

  // Escape backticks and ${} for template literal safety
  const escaped = content
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, "\\${");

  const updated = src.slice(0, afterStart) + escaped + src.slice(endIdx);
  writeFileSync(SESSION_PATH, updated);
  console.log(`Updated: ${SESSION_PATH}`);
}

function writeCoordinatorMd(content: string): void {
  const dir = join(homedir(), ".ppm", "bot");
  mkdirSync(dir, { recursive: true });
  writeFileSync(COORDINATOR_MD, content);
  console.log(`Written: ${COORDINATOR_MD}`);
}

// ── Main ───────────────────────────────────────────────────────────────

const cliArgs = process.argv.slice(2);
const groups = buildGroups();
const output = generateCoordinatorMd(groups);

if (cliArgs.includes("--update")) {
  writeCoordinatorMd(output);
  updateSourceDefault(output);
  console.log("\nDone. Review the changes and test with PPMBot.");
} else if (cliArgs.includes("--write-md")) {
  writeCoordinatorMd(output);
} else {
  console.log(output);
}
