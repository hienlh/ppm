import { appendFileSync, existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { redactLogText } from "../../shared/log-redact.ts";
import { formatLogLine } from "../logger.ts";
import { readAncestors, type AncestorProcess } from "./restart-caller-process-chain.ts";

/**
 * Who ran `ppm restart`, `ppm stop` or `ppm upgrade`. These commands used to leave only
 * "Windows command: restart server only" in `ppm.log`, so a restart nobody remembered asking for
 * could not be traced to anything. Now the command writes one line naming its own pid, the
 * processes above it with their command lines, the folder it ran in, the AI-chat mark and chat
 * session it carried and its `--reason`, and hands a short form to the supervisor (the Windows
 * command file) and to restart-news (the restart request file).
 *
 * Command lines can carry tokens, so everything that leaves this file goes through
 * {@link redactCommandLine}.
 */

export type CallerCommand = "restart" | "stop" | "upgrade";

/**
 * The variables that say which chat (if any) ran the command. Values are ids, never secrets.
 * `CLAUDE_PID` names the chat's CLI even where the parent chain breaks: Git Bash (MSYS) processes
 * report a Windows parent pid that has already exited, so the walk stops a level or two up.
 */
export const CALLER_ENV_KEYS = ["PPM_AI_CHAT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_PID", "CODEX_THREAD_ID", "AI_AGENT"] as const;

export interface RestartCaller {
  command: CallerCommand;
  /** The `ppm` process itself. */
  pid: number;
  /** Nearest first: parent, grandparent, … */
  ancestors: AncestorProcess[];
  cwd: string;
  env: Partial<Record<(typeof CALLER_ENV_KEYS)[number], string>>;
  reason?: string;
}

const CMD_MAX = 240;
const ENV_MAX = 80;
const REASON_MAX = 200;
/** The short form handed to restart-news; `cleanDetail` caps a detail at 200 as well. */
export const REQUESTED_BY_MAX = 200;

// A secret passed as a separate argument: `--token abc`, `-Password "x y"`, `--api-key=…` is caught
// by the log redactor already. Kept here because `redactLogText` keys on `=` and `:`.
const FLAG_SECRET = /(\s-{1,2}[\w-]*(?:token|secret|passw(?:or)?d|api[_-]?key|access[_-]?key|private[_-]?key|credential|authorization)[\w-]*\s+)("[^"]*"|'[^']*'|\S+)/gi;

/** Secrets out of a command line or any text this file writes; paths and ids stay, they are the point. */
export function redactCommandLine(text: string): string {
  return redactLogText(` ${text}`.replace(FLAG_SECRET, "$1[REDACTED]"), { home: false, email: false, chats: false }).slice(1);
}

/** One line, printable, capped, secrets out. */
function clean(text: string | undefined, max: number): string | undefined {
  if (!text) return undefined;
  const one = redactCommandLine(text.replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/g, " ").trim());
  if (!one) return undefined;
  const chars = Array.from(one);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : one;
}

/** The executable's name: what the system reported, else the first word of the command line. */
export function processName(p: AncestorProcess): string {
  if (p.name) return p.name;
  const first = p.cmd?.trim().match(/^"([^"]+)"|^(\S+)/);
  const exe = first ? (first[1] ?? first[2] ?? "") : "";
  return exe ? basename(exe.replace(/\\/g, "/")) : "?";
}

/** Gathers what describes this command's caller. Never throws. */
export async function collectRestartCaller(
  command: CallerCommand,
  reason: string | undefined,
  deps: { ppid?: number; pid?: number; cwd?: string; env?: Record<string, string | undefined>; ancestors?: (ppid: number) => Promise<AncestorProcess[]> } = {},
): Promise<RestartCaller> {
  const env = deps.env ?? process.env;
  let ancestors: AncestorProcess[] = [];
  try { ancestors = await (deps.ancestors ?? readAncestors)(deps.ppid ?? process.ppid); } catch { /* described without them */ }
  let cwd = "";
  try { cwd = deps.cwd ?? process.cwd(); } catch { /* the folder was removed */ }
  const picked: RestartCaller["env"] = {};
  for (const key of CALLER_ENV_KEYS) {
    const v = clean(env[key], ENV_MAX);
    if (v) picked[key] = v;
  }
  return { command, pid: deps.pid ?? process.pid, ancestors, cwd, env: picked, ...(reason?.trim() ? { reason: reason.trim() } : {}) };
}

const ROLE = ["parent", "grandparent"];

/** The full line for `ppm.log`. */
export function describeRestartCaller(c: RestartCaller): string {
  const parts = [`ppm ${c.command} run as pid ${c.pid}`];
  c.ancestors.forEach((p, i) => {
    const cmd = clean(p.cmd, CMD_MAX);
    parts.push(`${ROLE[i] ?? `ancestor ${i + 1}`} ${p.pid} ${processName(p)}${cmd ? ` ${JSON.stringify(cmd)}` : ""}`);
  });
  if (!c.ancestors.length) parts.push("parent process could not be read");
  if (c.cwd) parts.push(`cwd ${JSON.stringify(clean(c.cwd, CMD_MAX) ?? "")}`);
  const env = Object.entries(c.env).map(([k, v]) => `${k}=${v}`);
  parts.push(env.length ? env.join(" ") : "no AI-chat mark");
  const reason = clean(c.reason, REASON_MAX);
  parts.push(reason ? `reason ${JSON.stringify(reason)}` : "no --reason");
  return parts.join("; ");
}

/** The short form the supervisor and restart-news repeat: who, not the whole command line. */
export function requestedBySummary(c: RestartCaller): string {
  const chain = c.ancestors.map((p) => `${processName(p)} ${p.pid}`).join(" ← ");
  const session = c.env.CLAUDE_CODE_SESSION_ID ?? c.env.CODEX_THREAD_ID;
  const chat = c.env.PPM_AI_CHAT && c.env.PPM_AI_CHAT !== "0" ? `, from an AI chat${session ? ` (session ${session})` : ""}` : "";
  const text = `ppm ${c.command} (pid ${c.pid})${chain ? ` under ${chain}` : ""}${chat}`;
  return clean(text, REQUESTED_BY_MAX) ?? `ppm ${c.command}`;
}

/** Appends the line to `<ppmDir>/ppm.log` in the logger's format; a folder with no PPM is left alone. Never throws. */
export function logRestartCaller(ppmDir: string, c: RestartCaller): void {
  try {
    if (!existsSync(ppmDir)) return;
    appendFileSync(resolve(ppmDir, "ppm.log"), formatLogLine("info", "restart-caller", [describeRestartCaller(c)]));
  } catch { /* a restart must not fail over its log line */ }
}

/** Collects, logs, and answers the short form for the supervisor and restart-news. Never throws. */
export async function recordRestartCaller(ppmDir: string, command: CallerCommand, reason?: string): Promise<string> {
  try {
    const caller = await collectRestartCaller(command, reason);
    logRestartCaller(ppmDir, caller);
    return requestedBySummary(caller);
  } catch {
    return `ppm ${command}`;
  }
}
