import { readFileSync } from "node:fs";

/**
 * The processes above the one running `ppm restart`/`stop`/`upgrade`: its parent, grandparent and
 * a little further. On Windows a global `ppm` is a shim that starts bun, so the shell that typed the
 * command is the grandparent and the chat or script behind that shell one step further; two levels
 * alone would usually stop short of anything that names who asked.
 *
 * Every reader answers what it could and never throws: a process can exit between two reads, and a
 * restart must not fail because its caller could not be described.
 */

export interface AncestorProcess {
  pid: number;
  /** Its own parent, as the system reported it; 0 or absent at the top. */
  ppid?: number;
  /** The executable's name, when the system gives one apart from the command line. */
  name?: string;
  /** The full command line, as the system reported it. Not redacted here. */
  cmd?: string;
}

/** How many processes above the caller are read. */
export const ANCESTOR_DEPTH = 4;

const READ_TIMEOUT_MS = 5_000;

/** `/proc/<pid>/stat` → the parent pid. The name in parentheses can hold spaces and `)`. */
export function parseProcStatPpid(stat: string): number | undefined {
  const close = stat.lastIndexOf(")");
  if (close < 0) return undefined;
  const ppid = Number(stat.slice(close + 2).split(" ")[1]);
  return Number.isInteger(ppid) && ppid >= 0 ? ppid : undefined;
}

/** `/proc/<pid>/cmdline`: arguments separated by NUL, with a trailing NUL. */
export const parseProcCmdline = (raw: string): string => raw.replace(/\0+$/, "").split("\0").join(" ");

/** One line of `ps -o ppid=,command= -p <pid>`. */
export function parsePsLine(pid: number, out: string): AncestorProcess | null {
  const m = /^\s*(\d+)\s+(.*)$/.exec(out.split("\n")[0] ?? "");
  if (!m) return null;
  return { pid, ppid: Number(m[1]), cmd: m[2]!.trim() };
}

/** The base64 UTF-8 JSON the PowerShell walk prints (base64, so no console code page mangles a path). */
export function parseWindowsWalk(base64: string): AncestorProcess[] {
  try {
    const parsed = JSON.parse(Buffer.from(base64.trim(), "base64").toString("utf8")) as unknown;
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.flatMap((p) => {
      if (!p || typeof p !== "object") return [];
      const r = p as Record<string, unknown>;
      if (typeof r.pid !== "number") return [];
      return [{
        pid: r.pid,
        ...(typeof r.ppid === "number" ? { ppid: r.ppid } : {}),
        ...(typeof r.name === "string" && r.name ? { name: r.name } : {}),
        ...(typeof r.cmd === "string" && r.cmd ? { cmd: r.cmd } : {}),
      }];
    });
  } catch {
    return [];
  }
}

/** The PowerShell that walks `depth` processes up from `startPid` in one CIM session. */
export function windowsWalkScript(startPid: number, depth: number): string {
  return [
    "$ErrorActionPreference='SilentlyContinue'",
    `$out=@(); $id=${Math.trunc(startPid)}`,
    `for($i=0; $i -lt ${Math.trunc(depth)} -and $id -gt 0; $i++){`,
    "  $p=Get-CimInstance Win32_Process -Filter \"ProcessId=$id\"; if(-not $p){break}",
    "  $out+=[pscustomobject]@{pid=[int]$p.ProcessId; ppid=[int]$p.ParentProcessId; name=[string]$p.Name; cmd=[string]$p.CommandLine}",
    "  $id=[int]$p.ParentProcessId }",
    "[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject @($out) -Compress)))",
  ].join("\n");
}

/** Runs a command and answers its stdout, or "" on any failure. Async, with its own kill timer. */
async function runText(cmd: string[]): Promise<string> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    // Bun.spawn throws synchronously when the binary is missing.
    proc = Bun.spawn({ cmd, stdin: "ignore", stdout: "pipe", stderr: "ignore", windowsHide: true });
  } catch {
    return "";
  }
  const timer = setTimeout(() => { try { proc.kill(); } catch { /* gone */ } }, READ_TIMEOUT_MS);
  try {
    const text = await new Response(proc.stdout as ReadableStream).text();
    await proc.exited;
    return proc.exitCode === 0 ? text : "";
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

function readLinuxProcess(pid: number): AncestorProcess | null {
  try {
    const ppid = parseProcStatPpid(readFileSync(`/proc/${pid}/stat`, "utf8"));
    let cmd: string | undefined;
    try { cmd = parseProcCmdline(readFileSync(`/proc/${pid}/cmdline`, "utf8")) || undefined; } catch { /* exited */ }
    let name: string | undefined;
    try { name = readFileSync(`/proc/${pid}/comm`, "utf8").trim() || undefined; } catch { /* exited */ }
    return { pid, ...(ppid !== undefined ? { ppid } : {}), ...(name ? { name } : {}), ...(cmd ? { cmd } : {}) };
  } catch {
    return null;
  }
}

/** Walks up from `startPid` (normally `process.ppid`), nearest first. */
export async function readAncestors(
  startPid: number, depth = ANCESTOR_DEPTH, platform: NodeJS.Platform = process.platform,
): Promise<AncestorProcess[]> {
  if (!Number.isInteger(startPid) || startPid <= 0) return [];
  if (platform === "win32") {
    return parseWindowsWalk(await runText(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", windowsWalkScript(startPid, depth)]));
  }
  const chain: AncestorProcess[] = [];
  let pid = startPid;
  for (let i = 0; i < depth && pid > 0; i++) {
    const p = platform === "linux" ? readLinuxProcess(pid) : parsePsLine(pid, await runText(["ps", "-o", "ppid=,command=", "-p", String(pid)]));
    if (!p) break;
    chain.push(p);
    if (!p.ppid || p.ppid === pid) break;
    pid = p.ppid;
  }
  return chain;
}
