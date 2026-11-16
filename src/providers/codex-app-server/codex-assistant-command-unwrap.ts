/**
 * The script inside the shell wrapper of a Codex command approval, for the PPM Assistant's
 * read-only check. Only the exact wrappers Codex itself uses are recognised; any other shape
 * answers null and the command goes to a card, as every command did before. Codex's own parse
 * of the command (`commandActions` / `parsedCmd`) is display help and never trusted here.
 *
 * Codex sends the command two ways:
 *  - the current protocol, one display string: `/bin/bash -lc 'ls -la'` on Linux and macOS,
 *    `"C:\\Windows\\...\\powershell.exe" -Command dir` on Windows (the interpreter path quoted
 *    with every backslash doubled);
 *  - the legacy `execCommandApproval`, argv: `["bash", "-lc", "…"]`, `["pwsh", "-Command", "ls"]`.
 */
import { configService } from "../../services/config.service.ts";
import { assistantCommandApprovalVerdict, assistantMayActOnOwn } from "../../services/assistant/assistant-shell-decision.ts";

export interface UnwrappedCommand {
  shell: "bash" | "powershell";
  script: string;
}

const BASH_EXES = new Set(["bash", "/bin/bash", "/usr/bin/bash"]);
const BASH_FLAGS = new Set(["-lc", "-c"]);
const POWERSHELL_EXES = new Set(["powershell", "powershell.exe", "pwsh", "pwsh.exe"]);
/** Startup switches that change nothing about what the script does. */
const POWERSHELL_FLAGS = new Set(["-noprofile", "-noninteractive", "-nologo"]);

export function unwrapCodexCommand(command: unknown): UnwrappedCommand | null {
  if (Array.isArray(command)) return command.every((c) => typeof c === "string") ? unwrapArgv(command as string[]) : null;
  return typeof command === "string" ? unwrapDisplayString(command) : null;
}

function unwrapArgv(argv: string[]): UnwrappedCommand | null {
  if (argv.length === 3 && BASH_EXES.has(argv[0]!) && BASH_FLAGS.has(argv[1]!)) return { shell: "bash", script: argv[2]! };
  if (argv.length < 3 || !isPowerShellExe(argv[0]!)) return null;
  const flags = argv.slice(1, -2);
  if (!flags.every((f) => POWERSHELL_FLAGS.has(f.toLowerCase()))) return null;
  if (argv[argv.length - 2]!.toLowerCase() !== "-command") return null;
  return { shell: "powershell", script: argv[argv.length - 1]! };
}

/** The last component of an interpreter path, either separator, quotes already removed. */
function isPowerShellExe(path: string): boolean {
  const name = path.split(/[\\/]+/).filter(Boolean).pop() ?? "";
  return POWERSHELL_EXES.has(name.toLowerCase());
}

function unwrapDisplayString(text: string): UnwrappedCommand | null {
  const bash = /^(\S+) (-lc|-c) (.+)$/s.exec(text);
  if (bash && BASH_EXES.has(bash[1]!) && BASH_FLAGS.has(bash[2]!)) {
    const script = decodePosixWord(bash[3]!);
    return script === null ? null : { shell: "bash", script };
  }
  // An optionally double-quoted interpreter path, any of the harmless switches, then `-Command`.
  const ps = /^(?:"([^"]+)"|([^\s"]+))((?: -[A-Za-z]+)*?) -command (.+)$/is.exec(text);
  if (!ps) return null;
  if (!isPowerShellExe(ps[1] ?? ps[2]!)) return null;
  const flags = ps[3]!.split(" ").filter(Boolean);
  if (!flags.every((f) => POWERSHELL_FLAGS.has(f.toLowerCase()))) return null;
  const script = decodePowerShellRest(ps[4]!);
  return script === null ? null : { shell: "powershell", script };
}

/**
 * Exactly one POSIX shell word: single-quoted pieces joined by `\'` (`'it'\''s'`), or a bare word
 * made only of characters no shell treats specially. Anything else — double quotes, `$`, spaces
 * outside quotes, a second word — is null.
 */
export function decodePosixWord(text: string): string | null {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) return text;
  if (!/^'[^']*'(?:\\''[^']*')*$/.test(text)) return null;
  return text.slice(1, -1).split("'\\''").join("'");
}

/**
 * The script after `-Command`, used as shown only when it holds no `"`: Codex quotes an
 * argument for Windows' own command-line rules, and a `"` inside means the text shown is not
 * the text PowerShell receives. A fully double-quoted script with no `"` or `\` inside is
 * unquoted; anything else is null.
 */
function decodePowerShellRest(text: string): string | null {
  if (!text.includes('"')) return text;
  const quoted = /^"([^"\\]*)"$/.exec(text);
  return quoted ? quoted[1]! : null;
}

export type CodexAssistantApprovalAnswer =
  /** Answer Codex at once, with no card; `itemId` names the command whose result gets the badge. */
  | { answer: "accept" | "decline"; reason: string; itemId?: string }
  | { answer: "card"; reason: string };

/**
 * What a PPM Assistant session does with one Codex approval request before any card: accept a
 * command the read-only check passes, decline a file change unless the Assistant may act on its
 * own in this turn, and send everything else to a card as before. `sessionIds` are every id the
 * session is known by. Never throws: a failure is a card.
 */
export async function codexAssistantApprovalAnswer(
  method: string,
  params: unknown,
  sessionIds: readonly string[],
): Promise<CodexAssistantApprovalAnswer> {
  try {
    const p = params && typeof params === "object" && !Array.isArray(params) ? (params as Record<string, unknown>) : {};
    if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval") {
      return (await assistantMayActOnOwn(sessionIds))
        ? { answer: "card", reason: "the user lets the Assistant act on its own" }
        : { answer: "decline", reason: "file edits are off for the PPM Assistant" };
    }
    if (method !== "item/commandExecution/requestApproval" && method !== "execCommandApproval") return { answer: "card", reason: "not a command" };
    // Input to a running terminal, a network grant or extra permissions is more than running a read.
    if ((p.kind != null && p.kind !== "command") || p.networkApprovalContext != null || p.additionalPermissions != null) {
      return { answer: "card", reason: "the request asks for more than running a command" };
    }
    const verdict = await assistantCommandApprovalVerdict(unwrapCodexCommand(p.command), {
      projectRoots: configService.get("projects").map((project) => project.path),
    });
    if (!verdict.accept) return { answer: "card", reason: verdict.reason };
    const itemId = typeof p.itemId === "string" ? p.itemId : typeof p.callId === "string" ? p.callId : undefined;
    return { answer: "accept", reason: verdict.reason, ...(itemId ? { itemId } : {}) };
  } catch (err) {
    return { answer: "card", reason: `the read-only check failed: ${(err as Error)?.message ?? String(err)}` };
  }
}
