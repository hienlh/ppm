/**
 * Windows-only zombie-port reaper.
 *
 * When the server dies on Windows, descendants that inherited its listening
 * socket handle (CreateProcess bInheritHandles) keep the port in a zombie
 * LISTENING state attributed to the DEAD server PID. Both taskkill /T and the
 * tracked-descendant snapshot miss processes that daemonized — their parent
 * link broke before any snapshot ran (e.g. agent-browser detaching from a
 * short-lived bash tool, then spawning a headless-chrome tree). netstat keeps
 * attributing the socket to the dead PID, so port-holder lookup finds nothing
 * killable and the supervisor falls back to another port — which forces a
 * tunnel restart and rotates the public trycloudflare URL.
 *
 * Strategy: when the port is unbindable AND its netstat owner is dead, the
 * handle must be held by an orphaned descendant. Enumerate orphans (parent
 * PID no longer alive) and tree-kill — by exact PID — only those matching
 * known chat-tool debris signatures. Never touches cloudflared, the current
 * supervisor tree, or anything not on the whitelist.
 */
import { execFileSync } from "node:child_process";
import { findPortListenerPid } from "./windows-process-tree.ts";

interface ProcInfo {
  pid: number;
  ppid: number;
  name: string;
  cmd: string;
}

/**
 * Pure whitelist: does an ORPHANED process look like chat-tool debris that
 * may hold an inherited socket handle? Deliberately narrow — killing an
 * unrelated orphan (many apps daemonize by design: OneDrive, Slack, browsers)
 * would be a disaster. cloudflared is always protected regardless of matches.
 */
export function isDebrisOrphan(name: string, cmd: string): boolean {
  const n = name.toLowerCase();
  const c = cmd.toLowerCase();
  if (c.includes("cloudflared") || n.includes("cloudflared")) return false;
  // agent-browser daemon + its browsers (exe path or temp user-data-dir)
  if (c.includes("agent-browser")) return true;
  // Headless automation chrome only — real user Chrome never runs --headless
  if (n === "chrome.exe" && c.includes("--headless")) return true;
  // MSYS coreutils leaked by bash tool sessions (tail/cat/sleep …)
  if (c.includes("\\git\\usr\\bin\\")) return true;
  // Claude SDK node/bun children (chat tool subprocesses)
  if ((n === "node.exe" || n === "bun.exe") && c.includes("claude")) return true;
  return false;
}

/** One PowerShell call: pid|ppid|name|commandline for every process */
async function listProcessesDetailed(): Promise<ProcInfo[]> {
  const proc = Bun.spawn(
    [
      "powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.Name)|$($_.CommandLine)" }',
    ],
    { stdout: "pipe", stderr: "ignore", stdin: "ignore", windowsHide: true },
  );
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  const procs: ProcInfo[] = [];
  for (const line of out.split("\n")) {
    const parts = line.trim().split("|");
    if (parts.length < 3) continue;
    const pid = parseInt(parts[0] ?? "", 10);
    const ppid = parseInt(parts[1] ?? "", 10);
    if (isNaN(pid) || isNaN(ppid)) continue;
    // CommandLine may itself contain "|" — rejoin the remainder
    procs.push({ pid, ppid, name: parts[2] ?? "", cmd: parts.slice(3).join("|") });
  }
  return procs;
}

/**
 * Detect a zombie socket on `port` (LISTEN entry owned by a dead PID) and
 * kill orphaned debris processes that may hold the inherited handle.
 * Returns the number of orphan roots killed (0 = nothing to do / not zombie).
 * Caller should re-test bindability afterwards.
 */
export async function reapZombiePortOrphans(
  port: number,
  protectPids: Set<number>,
  log?: (msg: string) => void,
): Promise<number> {
  if (process.platform !== "win32") return 0;

  const holderPid = findPortListenerPid(port);
  if (holderPid <= 0) return 0; // nothing listening — different failure mode
  try {
    process.kill(holderPid, 0);
    return 0; // holder alive — caller's live-holder logic owns this case
  } catch {}
  log?.(`Port ${port} LISTEN owned by dead PID ${holderPid} (zombie socket) — hunting orphaned handle holders`);

  let procs: ProcInfo[];
  try {
    procs = await listProcessesDetailed();
  } catch (e) {
    log?.(`Zombie-port reaper: process enumeration failed: ${e}`);
    return 0;
  }

  const alive = new Set(procs.map((p) => p.pid));
  let killed = 0;
  for (const p of procs) {
    if (alive.has(p.ppid)) continue;           // parent alive — not an orphan
    if (protectPids.has(p.pid)) continue;      // supervisor / server / tunnel
    if (!isDebrisOrphan(p.name, p.cmd)) continue;
    try {
      // Tree-kill: the orphan root's own children still have a live parent
      // (the root itself) so they never match the orphan filter directly.
      execFileSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], {
        stdio: "ignore", timeout: 5000, windowsHide: true,
      });
      killed++;
      log?.(`Reaped orphaned debris ${p.name} (PID: ${p.pid}) holding zombie port ${port}`);
    } catch {}
  }
  return killed;
}
