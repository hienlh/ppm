/**
 * Which approval requests can be remembered, and as what. A remembered approval is a rule the user
 * made by pressing "approve this kind next time" on a card: PPM then approves requests matching it
 * without a card, in that project only.
 *
 * The pattern is always worked out here from the request itself, on the server, never taken from
 * a screen or a Telegram button. What may be remembered (anything else has no pattern):
 * - a session tool opening a chat in the same project (`collab:create`), or keeping two chats
 *   messaging each other past the limit (`collab:pair_limit`);
 * - a shell command, by its first word or two (`git status`, `bun test`, `python scripts/x.py`),
 *   only when it is one plain command: no joining, piping, redirecting or substitution;
 * - a file edit, by the project folder it is in (`src/web/`);
 * - a built-in tool that only reads or hands work to a subagent, by name;
 * - an MCP tool, by its full name, when the name says nothing of acting on the world.
 *
 * `matchesRule` decides again, for every request, everything `approvalPatternFor` decided when the
 * rule was made: a rule for `git status` never approves `git status && rm -rf x`.
 */
import {
  COMMAND_JOINERS, DENIED_COMMANDS, DENIED_FLAGS, DENIED_GIT_FLAGS, DENIED_GIT_SUBCOMMANDS, DENIED_MCP_WORDS,
  DENIED_COMMAND_NAME_WORDS, DENIED_PACKAGE_SUBCOMMANDS, DENIED_PATH_PARTS, DENIED_TOOLS, IN_PLACE_EDITORS, IN_PLACE_FLAG,
  INLINE_CODE_FLAGS, INTERPRETERS, PACKAGE_MANAGERS, REMEMBERABLE_TOOLS, SUBCOMMAND_TOOLS,
} from "./remembered-approval-denylist.ts";

export const APPROVAL_RULE_KINDS = ["collab:create", "collab:pair_limit", "command", "file_edit", "tool", "mcp_tool"] as const;
export type ApprovalRuleKind = (typeof APPROVAL_RULE_KINDS)[number];

/** A request as rememberable: what is stored and compared, and how it is named to the user. */
export interface ApprovalPattern {
  kind: ApprovalRuleKind;
  /** Compared exactly (a tool name, a folder) or as a command prefix (`command`). */
  pattern: string;
  /** "Run `git status`", "Edit files in src/web/": what the rule approves, in words. */
  label: string;
}

/** The request a card asks about, as the pattern needs it. */
export interface ApprovalRequestShape {
  tool: string;
  input: unknown;
  /** The project's folder: a file edit is remembered by its folder inside it. */
  projectPath: string;
}

/** The session tools' card (`ppm:session_collab`), named here to keep this module free of server code. */
const SESSION_COLLAB_TOOL = "ppm:session_collab";
const SHELL_TOOLS = new Set(["Bash", "PowerShell", "Shell", "shell", "bash"]);
const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const MAX_PATTERN = 200;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The pattern a card's request can be remembered as; null when it can never be remembered. */
export function approvalPatternFor(req: ApprovalRequestShape): ApprovalPattern | null {
  if (DENIED_TOOLS.has(req.tool)) return null;
  if (req.tool === SESSION_COLLAB_TOOL) return collabPattern(req.input);
  if (SHELL_TOOLS.has(req.tool)) return commandPattern(isObj(req.input) ? req.input.command : undefined);
  if (FILE_TOOLS.has(req.tool)) return fileEditPattern(req.input, req.projectPath);
  if (REMEMBERABLE_TOOLS.has(req.tool)) return { kind: "tool", pattern: req.tool, label: `Use ${req.tool}` };
  if (isMcpTool(req.tool)) {
    if (DENIED_MCP_WORDS.test(mcpToolPart(req.tool))) return null;
    return { kind: "mcp_tool", pattern: req.tool, label: `Use ${req.tool}` };
  }
  return null;
}

/** Whether a stored rule approves this request now. Every refusal is decided again here. */
export function matchesRule(rule: { kind: string; pattern: string }, req: ApprovalRequestShape): boolean {
  const now = approvalPatternFor(req);
  if (!now || now.kind !== rule.kind) return false;
  if (rule.kind === "command") return commandStartsWith(now.pattern, rule.pattern, req.input);
  if (rule.kind === "file_edit") return isInside(now.pattern, rule.pattern);
  return now.pattern === rule.pattern;
}

function collabPattern(input: unknown): ApprovalPattern | null {
  if (!isObj(input)) return null;
  // The Assistant's own requests are answered one at a time, by design: never remembered.
  if (input.askedBy === "assistant") return null;
  if (input.kind === "create") return { kind: "collab:create", pattern: "create", label: "Open a new chat in this project" };
  if (input.kind === "pair_limit") return { kind: "collab:pair_limit", pattern: "pair_limit", label: "Let two chats keep messaging each other" };
  // An escalation (writing to a chat with more permissions), a message the Assistant sends, a schedule: never.
  return null;
}

/** Splits a plain command into words, keeping quoted words whole; null when it is not one plain command. */
export function commandWords(command: unknown): string[] | null {
  if (typeof command !== "string") return null;
  const text = command.trim();
  if (!text || text.length > 2000 || COMMAND_JOINERS.test(text)) return null;
  const words: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) words.push(m[1] ?? m[2] ?? m[3] ?? "");
  return words.length ? words : null;
}

/** Whether a command, as a whole, is one a rule could ever approve. */
export function commandRefusal(words: readonly string[]): string | null {
  const first = commandName(words[0]!);
  const second = (words[1] ?? "").toLowerCase();
  if (DENIED_COMMANDS.has(first)) return `${first} is never approved without a card`;
  if (DENIED_COMMAND_NAME_WORDS.test(first)) return `${first} is never approved without a card`;
  for (const w of words) if (DENIED_FLAGS.has(w)) return `${w} is never approved without a card`;
  if (first === "git") {
    if (DENIED_GIT_SUBCOMMANDS.has(second)) return `git ${second} is never approved without a card`;
    for (const w of words) if (DENIED_GIT_FLAGS.has(w)) return `git ${w} is never approved without a card`;
  }
  if (PACKAGE_MANAGERS.has(first)) {
    if (DENIED_PACKAGE_SUBCOMMANDS.has(second)) return `${first} ${second} is never approved without a card`;
  }
  if (INTERPRETERS.has(first)) {
    for (const w of words.slice(1)) if (INLINE_CODE_FLAGS.has(w)) return `${first} ${w} runs code that is not on the card`;
  }
  if (IN_PLACE_EDITORS.has(first)) {
    for (const w of words.slice(1)) if (IN_PLACE_FLAG.test(w)) return `${first} ${w} rewrites files`;
  }
  return null;
}

/** A command's first word as compared: its own name, lower case, without a folder or `.exe`. */
function commandName(word: string): string {
  const base = word.replace(/\\/g, "/").split("/").pop() ?? word;
  return base.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, "");
}

/**
 * The prefix a command is remembered by: its first word, and the next when that names a
 * subcommand (`git status`, `bun test`) or the script an interpreter runs (`python scripts/x.py`).
 * A runner's script name follows too (`bun run build`). For any other command the next word is
 * an argument, so the rule covers the command by name (`grep`, `ls`).
 */
function commandPattern(command: unknown): ApprovalPattern | null {
  const words = commandWords(command);
  if (!words || commandRefusal(words)) return null;
  const first = commandName(words[0]!);
  const prefix = [first];
  const next = words[1];
  const takesSubcommand = SUBCOMMAND_TOOLS.has(first) || PACKAGE_MANAGERS.has(first) || INTERPRETERS.has(first);
  if (takesSubcommand && next && !next.startsWith("-")) {
    prefix.push(next);
    if (PACKAGE_MANAGERS.has(first) && next === "run" && words[2] && !words[2].startsWith("-")) prefix.push(words[2]);
  }
  const pattern = prefix.join(" ");
  if (pattern.length > MAX_PATTERN) return null;
  return { kind: "command", pattern, label: `Run \`${pattern}\`` };
}

/** Whether a command (as its own pattern) starts with a rule's prefix, word for word. */
function commandStartsWith(ownPattern: string, rulePrefix: string, input: unknown): boolean {
  const words = commandWords(isObj(input) ? input.command : undefined);
  if (!words || commandRefusal(words)) return false;
  const named = [commandName(words[0]!), ...words.slice(1)];
  const want = rulePrefix.split(" ");
  if (named.length < want.length) return false;
  return want.every((w, i) => named[i] === w) && ownPattern.split(" ")[0] === want[0];
}

/** Every file a file edit touches: Claude names one, Codex may list several. */
function editedFiles(input: unknown): string[] {
  if (!isObj(input)) return [];
  if (typeof input.file_path === "string") return [input.file_path];
  if (typeof input.notebook_path === "string") return [input.notebook_path];
  if (Array.isArray(input.files)) return input.files.filter((f): f is string => typeof f === "string");
  return [];
}

const slashes = (p: string): string => p.replace(/\\/g, "/");
const isAbsolute = (p: string): boolean => /^([a-z]:)?[\\/]/i.test(p) || /^[a-z]:$/i.test(p);

/** A path's parts with `.` and `..` worked out; null when `..` climbs above where it starts. */
function pathParts(p: string): string[] | null {
  const out: string[] = [];
  for (const part of slashes(p).split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out;
}

/** A path inside the project, relative to it, with forward slashes; null when outside it. */
export function projectRelative(file: string, projectPath: string): string | null {
  const root = pathParts(projectPath);
  const target = pathParts(isAbsolute(file) ? file : `${projectPath}/${file}`);
  if (!root || !target || root.length === 0) return null;
  // A Windows folder is the same folder however its letters are cased.
  const caseless = /^[a-z]:$/i.test(root[0]!);
  const same = (a: string, b: string | undefined) => b !== undefined && (caseless ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (!root.every((part, i) => same(part, target[i]))) return null;
  return target.slice(root.length).join("/");
}

/** The folder of the edited files, when every one is inside the project and none is a secret. */
function fileEditPattern(input: unknown, projectPath: string): ApprovalPattern | null {
  const files = editedFiles(input);
  if (files.length === 0) return null;
  const folders: string[] = [];
  for (const file of files) {
    const rel = projectRelative(file, projectPath);
    if (rel === null || rel === "" || DENIED_PATH_PARTS.test(rel)) return null;
    const cut = rel.lastIndexOf("/");
    folders.push(cut < 0 ? "" : `${rel.slice(0, cut)}/`);
  }
  // Several files: the folder that holds them all.
  let folder = folders[0]!;
  for (const f of folders.slice(1)) while (!f.startsWith(folder)) folder = folder.slice(0, folder.slice(0, -1).lastIndexOf("/") + 1);
  if (folder.length > MAX_PATTERN) return null;
  return { kind: "file_edit", pattern: folder, label: folder ? `Edit files in ${folder}` : "Edit files at the project's top level" };
}

/** Whether a folder is the rule's folder or inside it. The top level covers only itself. */
function isInside(folder: string, ruleFolder: string): boolean {
  if (ruleFolder === "") return folder === "";
  return folder.startsWith(ruleFolder);
}

function isMcpTool(tool: string): boolean {
  return tool.startsWith("mcp__") || /^[\w-]+\.[\w-]+$/.test(tool);
}

/** The tool's own name inside an MCP tool's full name (`mcp__server__tool`, `server.tool`). */
function mcpToolPart(tool: string): string {
  if (tool.startsWith("mcp__")) return tool.split("__").slice(2).join("__") || tool;
  return tool.split(".").pop() ?? tool;
}
