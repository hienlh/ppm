/**
 * How many monitors of its own this PC has, by exactly the helper's definition: the PowerShell
 * `Get-HardwareMonitorCount` from `virtual-display-safety-script.ts`, run as PPM's own user (it
 * only reads devices). One definition on both sides, so "the PC has no monitor" never means two
 * things.
 *
 * Used to tell Windows' fallback screen apart from a real monitor: on a PC with no monitor
 * attached, a session newly brought to the console gets a stand-in screen from the GPU (measured
 * on a headless Windows 11 host with an RTX 4070: `\\.\DISPLAY1`, 1024x768) that has no Monitor
 * device behind it. NOT YET CONFIRMED on a real host in that state: the rule is derived from the
 * device list seen there, and needs one real test (virtual display off, session brought to the
 * console, this answering 0).
 *
 * A PowerShell start costs about 0.6 s, so the answer is cached; null when it cannot be read.
 */
import { powershellExe } from "./helper-paths.ts";
import { helperSystem } from "./helper-system.ts";
import { encodePowerShell } from "./powershell-text.ts";
import { VIRTUAL_DISPLAY_SAFETY } from "./virtual-display-safety-script.ts";

const CACHE_MS = 30_000;
const RUN_TIMEOUT_MS = 15_000;

/** The helper's own functions, then just the count. `Get-ConsoleUserSession` is defined in the
 *  same block but never called here, so the C# it needs is not compiled. */
export const HARDWARE_MONITOR_QUERY = `$ErrorActionPreference = 'Stop'
${VIRTUAL_DISPLAY_SAFETY}
Get-HardwareMonitorCount
`;

let cached: { at: number; count: number | null } | null = null;

export async function hardwareMonitorCount(): Promise<number | null> {
  const sys = helperSystem();
  if (sys.platform !== "win32") return null;
  if (cached && sys.now() - cached.at < CACHE_MS) return cached.count;
  const r = await sys.run([powershellExe(), "-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(HARDWARE_MONITOR_QUERY)], RUN_TIMEOUT_MS);
  const n = r.code === 0 ? Number.parseInt(r.stdout.trim().split(/\r?\n/).at(-1) ?? "", 10) : NaN;
  const count = Number.isInteger(n) && n >= 0 ? n : null;
  cached = { at: sys.now(), count };
  return count;
}

/** Tests only. */
export function resetHardwareMonitorCountForTests(): void {
  cached = null;
}
