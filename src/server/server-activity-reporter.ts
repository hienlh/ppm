/**
 * Writes this server's activity report every 30 s, for the supervisor's memory recycle
 * (`process-recycle-policy.ts`, `server-activity-file.ts`). Only where the recycle runs (Windows),
 * only under a supervisor, and never throwing into the server: a report that cannot be written just
 * goes stale, and a stale report keeps the supervisor from restarting anything.
 */
import { getPpmDir } from "../services/ppm-dir.ts";
import { serverRecycleLimitMB, supervisorRecycleLimitMB, type ServerActivity } from "../services/process-recycle-policy.ts";
import {
  nextServerActivity, removeOtherServerActivity, removeServerActivity, SERVER_ACTIVITY_INTERVAL_MS, TERMINAL_ACTIVE_MS,
  writeServerActivity,
} from "../services/server-activity-file.ts";
import { terminalService } from "../services/terminal.service.ts";
import { busyChatCount } from "./ws/chat.ts";
import { openRemoteDesktopSockets } from "./ws/remote-desktop.ts";

let timer: ReturnType<typeof setInterval> | null = null;

export function startServerActivityReporter(): void {
  if (timer) return;
  if (supervisorRecycleLimitMB() === null && serverRecycleLimitMB() === null) return;
  const ppmDir = getPpmDir();
  removeOtherServerActivity(ppmDir, process.pid);
  let last: ServerActivity | null = null;
  const tick = () => {
    try {
      const now = Date.now();
      const activeTerminals = terminalService.list()
        .filter((t) => t.lastOutputAt !== null && now - t.lastOutputAt < TERMINAL_ACTIVE_MS).length;
      last = nextServerActivity(process.pid, now, {
        busyChats: busyChatCount(),
        activeTerminals,
        remoteDesktopSessions: openRemoteDesktopSockets(),
      }, last);
      writeServerActivity(ppmDir, last);
    } catch { /* stale report: the supervisor waits */ }
  };
  tick();
  timer = setInterval(tick, SERVER_ACTIVITY_INTERVAL_MS);
  process.on("exit", () => removeServerActivity(ppmDir, process.pid));
}
