import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { query as sdkQuery, type SpawnedProcess, type SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "../services/logger.ts";

/**
 * The Claude CLI as the leader of a process group of its own, and that group ended when the CLI
 * exits.
 *
 * The CLI starts its stdio MCP servers (`npm exec @playwright/mcp`, `slack-mcp-server`, …) in its
 * own process group, and the SDK's spawn left the CLI in PPM's — so every CLI and every MCP server
 * of every session shared one group, and nothing could tell a server whose CLI was gone from a live
 * one. On 2026-10-20 ~30 `npm exec` + node families (and their Chromes) sat in ppm.service hours
 * after their CLI was gone, adding to the swap all day until systemd-oomd killed the unit and every
 * session in it. In a group of its own, whatever a CLI leaves behind gets SIGTERM the moment it
 * exits (Playwright MCP closes its browser on it) and SIGKILL if it is still there
 * `GROUP_KILL_GRACE_MS` later.
 *
 * The Bash tool's commands are not in that group: the CLI starts each in a session of its own, so
 * a server or an emulator a command left running is not touched. Windows has no process groups;
 * there the SDK spawns the CLI itself, as before.
 */

/** Longer than Playwright MCP's own 15 s limit on closing its browsers. */
export const GROUP_KILL_GRACE_MS = 20_000;
const GROUP_POLL_MS = 500;
/** How long the SDK's own spawn waits for stderr to close after the exit. */
const STDERR_DRAIN_MS = 200;
const EXIT_AFTER_STDERR = "ppm-exit-after-stderr";

const log = createLogger("cli-group");

function signalGroup(pgid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * SIGTERM to the group now, SIGKILL after `graceMs` to whatever is still in it. The group is
 * checked until it is empty: its id cannot go to a new process while a member lives, which is
 * what makes a SIGKILL aimed at it seconds later safe.
 */
export function endProcessGroup(pgid: number, graceMs = GROUP_KILL_GRACE_MS): void {
  if (!signalGroup(pgid, "SIGTERM")) return;
  const deadline = Date.now() + graceMs;
  const timer = setInterval(() => {
    if (!signalGroup(pgid, 0)) return clearInterval(timer);
    if (Date.now() < deadline) return;
    log.warn(`process group ${pgid} still there ${graceMs} ms after SIGTERM: ${groupMembers(pgid).join(", ") || "?"}; SIGKILL`);
    signalGroup(pgid, "SIGKILL");
    clearInterval(timer);
  }, GROUP_POLL_MS);
  timer.unref();
}

/** Who is in a process group, by name, for the log. Linux only. */
function groupMembers(pgid: number): string[] {
  if (process.platform !== "linux") return [];
  const names: string[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      if (Number(stat.slice(close + 2).split(" ")[2]) === pgid) names.push(`${stat.slice(stat.indexOf("(") + 1, close)}:${entry}`);
    } catch {}
  }
  return names;
}

/**
 * Spawns the CLI as the SDK does — except in a process group of its own, ended on exit. A custom
 * spawn takes stderr away from the SDK, so it is handed to `onStderr` (the query's `stderr`
 * option) here, and `exit` is delivered only once stderr has closed, as the SDK's spawn does, so a
 * crash is logged with its whole stderr.
 */
export function spawnCliInOwnGroup(
  options: SpawnOptions,
  onStderr?: (chunk: string) => void,
  graceMs?: number,
): SpawnedProcess {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    signal: options.signal,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  child.once("exit", (code, signal) => {
    const pid = child.pid;
    if (!pid || !signalGroup(pid, 0)) return;
    // Nothing should be left by now: name what is, and how the CLI ended, so the cause can be found.
    const at = options.args.findIndex((a) => a === "--session-id" || a === "--resume");
    const session = at >= 0 ? options.args[at + 1] : undefined;
    log.warn(`CLI pid=${pid}${session ? ` session=${session}` : ""} exited (${signal ?? code}) leaving ${groupMembers(pid).join(", ") || "its group"}; SIGTERM`);
    endProcessGroup(pid, graceMs);
  });

  const decoder = new StringDecoder("utf8");
  let delivered = false;
  let exited = false;
  let stderrClosed = false;
  let drain: ReturnType<typeof setTimeout> | undefined;
  const deliverExit = () => {
    if (delivered) return;
    delivered = true;
    clearTimeout(drain);
    child.emit(EXIT_AFTER_STDERR, child.exitCode, child.signalCode);
  };
  const forward = (text: string) => {
    if (text && !delivered) onStderr?.(text);
  };
  child.stderr.on("data", (chunk: Buffer) => forward(decoder.write(chunk)));
  child.stderr.on("error", () => {});
  child.stderr.once("close", () => {
    forward(decoder.end());
    stderrClosed = true;
    if (exited) deliverExit();
  });
  child.once("exit", () => {
    exited = true;
    if (stderrClosed) deliverExit();
    else drain = setTimeout(deliverExit, STDERR_DRAIN_MS);
  });

  const eventName = (name: string) => (name === "exit" ? EXIT_AFTER_STDERR : name);
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    get killed() { return child.killed; },
    get exitCode() { return child.exitCode; },
    get signalCode() { return child.signalCode; },
    kill: (signal: NodeJS.Signals) => child.kill(signal),
    on: (name: string, listener: (...args: any[]) => void) => { child.on(eventName(name), listener); },
    once: (name: string, listener: (...args: any[]) => void) => { child.once(eventName(name), listener); },
    off: (name: string, listener: (...args: any[]) => void) => { child.off(eventName(name), listener); },
  } as SpawnedProcess;
}

/** The SDK's `query()`, with every CLI it starts spawned by `spawnCliInOwnGroup`. */
export const query: typeof sdkQuery = (params) => {
  if (process.platform === "win32" || params.options?.spawnClaudeCodeProcess) return sdkQuery(params);
  const stderr = params.options?.stderr;
  return sdkQuery({
    ...params,
    options: { ...params.options, spawnClaudeCodeProcess: (o) => spawnCliInOwnGroup(o, stderr) },
  });
};
