/**
 * Per-process network bytes on macOS via `nettop`. This is the ONLY mainstream
 * OS with an unprivileged per-process network source: Windows needs an ETW
 * session and Linux needs packet capture, so both leave the Net column hidden.
 *
 *   nettop -n -P -x -L 1 -J bytes_in,bytes_out
 *     -n  no name lookups. Without it every sample resolves the remote address of
 *         each connection: 18 DNS queries a run, one run every tick, telling the
 *         resolver what this machine talks to (0 with -n, same rows and columns)
 *     -P  aggregate per process instead of per connection
 *     -x  raw byte counts, no "1.2M" suffixes
 *     -L 1  one CSV sample, then exit (no interactive curses mode)
 *     -J  emit only these two columns
 *
 * The CSV shape varies between macOS releases (a leading timestamp column comes
 * and goes), so the parser hunts for the `<name>.<pid>` cell and takes the next
 * two numeric cells rather than trusting fixed column indexes.
 *
 * Run on an M1 Max (macOS 15): 52 process rows, the same rows and columns with
 * and without `-n`.
 */
import type { Runner } from "../host-info/spawn-runner.ts";
import { defaultRunner } from "../host-info/spawn-runner.ts";
import { createLogger, type Logger } from "../logger.ts";

export const NETTOP_ARGV = ["nettop", "-n", "-P", "-x", "-L", "1", "-J", "bytes_in,bytes_out"];
const NETTOP_TIMEOUT_MS = 5000;

export interface ProcNetBytes {
  inBytes: number;
  outBytes: number;
}

/** `<process name>.<pid>` — the name may itself contain dots
 *  ("com.apple.WebKit.Networking.431"), so the pid is the LAST segment. The
 *  name must contain a letter: the leading timestamp cell some macOS releases
 *  emit ("14:33:05.976") is otherwise a perfect match and would invent a pid
 *  out of the fractional seconds. */
const NAME_PID_CELL = /^(.+)\.(\d+)$/;
const NUMERIC_CELL = /^\d+$/;

function pidCell(cell: string): number | null {
  const m = NAME_PID_CELL.exec(cell);
  if (!m || !/[A-Za-z]/.test(m[1]!)) return null;
  const pid = Number(m[2]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function parseNettopCsv(text: string): Map<number, ProcNetBytes> {
  const byPid = new Map<number, ProcNetBytes>();
  for (const line of text.split("\n")) {
    const cells = line.split(",").map((c) => c.trim());
    const at = cells.findIndex((c) => pidCell(c) !== null);
    if (at < 0) continue;
    const pid = pidCell(cells[at]!)!;
    const numbers = cells.slice(at + 1).filter((c) => NUMERIC_CELL.test(c));
    if (numbers.length < 2) continue;
    const inBytes = Number(numbers[0]);
    const outBytes = Number(numbers[1]);
    if (!Number.isFinite(inBytes) || !Number.isFinite(outBytes)) continue;
    // A pid can appear twice when nettop splits interfaces; sum them.
    const prev = byPid.get(pid);
    byPid.set(pid, {
      inBytes: (prev?.inBytes ?? 0) + inBytes,
      outBytes: (prev?.outBytes ?? 0) + outBytes,
    });
  }
  return byPid;
}

export interface ProcessNetCollector {
  /** Null when the sample failed — the rows then carry no net figures at all
   *  rather than a fabricated 0. */
  collect(): Promise<Map<number, ProcNetBytes> | null>;
  isDisabled(): boolean;
}

const MAX_FAILURES = 3;

export function createDarwinProcessNetCollector(
  run: Runner = defaultRunner,
  log: Logger = createLogger("SystemMetrics"),
): ProcessNetCollector {
  let failures = 0;
  let disabled = false;
  let logged = false;
  return {
    isDisabled: () => disabled,
    async collect() {
      if (disabled) return null;
      const startedAt = Date.now();
      try {
        const r = await run(NETTOP_ARGV, NETTOP_TIMEOUT_MS);
        if (r.code !== 0 || r.timedOut) throw new Error(r.timedOut ? "timed out" : r.stderr || `exit ${r.code}`);
        failures = 0;
        if (!logged) {
          logged = true;
          // The 2 s tick budget is what breaks first if nettop turns out slow.
          log.info(`nettop sample: ${Date.now() - startedAt} ms`);
        }
        return parseNettopCsv(r.stdout);
      } catch (e) {
        if (++failures >= MAX_FAILURES) {
          disabled = true;
          // Given up on for the life of the server: say so, unless nettop simply is not there.
          const reason = (e as Error)?.message ?? String(e);
          if (!/ENOENT|Executable not found/i.test(reason)) {
            log.warn(`nettop disabled after ${failures} failures: ${reason.replace(/\s+/g, " ").trim().slice(0, 300)}`);
          }
        }
        return null;
      }
    },
  };
}
