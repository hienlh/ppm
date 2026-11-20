import { belowFreeGB } from "../../shared/memory-guard.ts";
import type { Growth } from "../memory-pulse.ts";

/**
 * When the memory guard tells the user the machine is running out of memory, and what it says.
 * Pure.
 *
 * Two levels: under the warn threshold (15 GB free by default) and under the block threshold
 * (10 GB). A notification goes out each time the level rises, never twice for the same level, and
 * the level falls back to 0 only once free commit is comfortably above the warn threshold again
 * (+{@link RECOVER_MARGIN_GB}), so a reading that hovers at the line does not send one a minute.
 */

export type AlertLevel = 0 | 1 | 2;
export const RECOVER_MARGIN_GB = 3;

export function nextAlertLevel(prev: AlertLevel, freeMB: number, warnGB: number, blockGB: number): { level: AlertLevel; notify: boolean } {
  const now: AlertLevel = belowFreeGB(freeMB, blockGB) ? 2 : belowFreeGB(freeMB, warnGB) ? 1 : 0;
  if (now > prev) return { level: now, notify: true };
  // Falling back: only once well clear of the warn line, and then all the way.
  if (now < prev && !belowFreeGB(freeMB, warnGB + RECOVER_MARGIN_GB)) return { level: 0, notify: false };
  return { level: prev, notify: false };
}

export interface LowMemoryFacts {
  freeMB: number;
  limitMB: number;
  level: 1 | 2;
  blockGB: number;
  growth: Growth | null;
  /** The growing chat's title and project, when it is a chat PPM knows. */
  growthChat?: { title: string | null; project: string | null } | null;
  mcpServers?: number;
  released: number;
}

const gb = (mb: number) => (mb / 1024).toFixed(1);

/** Title and body of the notification. Measurements only: which chat grew, never "caused". */
export function lowMemoryMessage(f: LowMemoryFacts): { title: string; body: string } {
  const title = `Low memory: ${gb(f.freeMB)} of ${gb(f.limitMB)} GB free`;
  const lines: string[] = [];
  if (f.growth) {
    const delta = f.growth.toMB - f.growth.fromMB;
    const who = f.growth.session
      ? `chat ${f.growthChat?.title ? `"${f.growthChat.title}"` : f.growth.session.slice(0, 8)}${f.growthChat?.project ? ` (${f.growthChat.project})` : ""}`
      : `${f.growth.label ?? f.growth.name} (pid ${f.growth.pid})`;
    lines.push(delta > 0 && f.growth.seconds > 0
      ? `Growing fastest: ${who}, +${delta} MB in ${f.growth.seconds} s (now ${f.growth.toMB} MB).`
      : `Biggest: ${who}, ${f.growth.toMB} MB.`);
  }
  if (f.mcpServers) lines.push(`${f.mcpServers} MCP server processes are running under the chats.`);
  if (f.released) lines.push(`PPM released ${f.released} quiet chat subprocess${f.released > 1 ? "es" : ""}.`);
  if (f.level === 2) lines.push(`Under ${f.blockGB} GB: new test runs, type checks and builds from chats are held until memory comes back.`);
  return { title, body: lines.join(" ") };
}
