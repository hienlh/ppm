import { createLogger } from "./logger.ts";
import { descendantsOf, readProcessList, type ProcessMemoryEntry } from "./process-tree-memory.ts";

const log = createLogger("cli-reaper");

/**
 * What a chat's Claude CLI started — its MCP servers (`cmd /c npx @playwright/mcp …` and the node
 * under it), its shells — and that outlives the CLI when PPM releases it.
 *
 * Windows only. On Linux and macOS `claude-cli-process-group.ts` gives each CLI a process group of
 * its own and SIGTERMs the group when the CLI exits. Windows has no such thing: ending `claude.exe`
 * leaves its children running, parentless, holding the memory the release was meant to free. Each
 * Playwright MCP server is two node processes; on 20/11/2026 there were 18 of them.
 *
 * Taken in two halves around the release: who is below the CLI is read *before* (once the CLI is
 * gone its children no longer name a live parent and cannot be told from anyone's), and whatever of
 * that list is still the same process a few seconds *after* is ended by pid — never by name. A pid
 * the OS has since handed to another process has a different start time and is left alone.
 */

export interface CliLeftover {
  pid: number;
  startedAt: number;
}

/** The processes below `cliPids` in `list`, the CLIs themselves excluded. Exported for tests. */
export function cliDescendants(list: ProcessMemoryEntry[], cliPids: readonly number[]): CliLeftover[] {
  const out: CliLeftover[] = [];
  for (const pid of cliPids) {
    for (const d of descendantsOf(pid, list)) out.push({ pid: d.pid, startedAt: d.startedAt });
  }
  return out;
}

/** Which of `snapshot` are still the same processes in `list`. Exported for tests. */
export function stillRunning(snapshot: readonly CliLeftover[], list: ProcessMemoryEntry[]): number[] {
  const now = new Map(list.map((p) => [p.pid, p.startedAt]));
  return snapshot.filter((s) => now.get(s.pid) === s.startedAt).map((s) => s.pid);
}

/**
 * The descendants of these CLIs right now (`spawnTracker.pidsForSession` names them); empty off
 * Windows or when unreadable. A CLI that has already exited still has its children found, by the
 * parent pid they keep.
 */
export async function snapshotCliLeftovers(cliPids: readonly number[]): Promise<CliLeftover[]> {
  if (process.platform !== "win32") return [];
  try {
    if (cliPids.length === 0) return [];
    const list = await readProcessList(process.pid);
    return list ? cliDescendants(list, cliPids) : [];
  } catch {
    return [];
  }
}

/** After `graceMs`, end whatever of `snapshot` is still running. Never throws. */
export async function reapCliLeftovers(sessionId: string, snapshot: readonly CliLeftover[], graceMs = 3000): Promise<number> {
  if (snapshot.length === 0) return 0;
  await Bun.sleep(graceMs);
  try {
    const list = await readProcessList(process.pid);
    if (!list) return 0;
    const pids = stillRunning(snapshot, list);
    for (const pid of pids) {
      try { process.kill(pid, "SIGKILL"); } catch { /* gone meanwhile */ }
    }
    if (pids.length) log.info(`session=${sessionId} ended ${pids.length} process(es) its released CLI left running (MCP servers, shells)`);
    return pids.length;
  } catch {
    return 0;
  }
}
