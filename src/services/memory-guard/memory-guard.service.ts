import { belowFreeGB, memoryGuardSettings, type MemoryGuardSettings } from "../../shared/memory-guard.ts";
import { createLogger } from "../logger.ts";
import { fastestGrowth, type PulseSample } from "../memory-pulse.ts";
import { describeCommit } from "../system-commit.ts";
import { lowMemoryMessage, nextAlertLevel, type AlertLevel } from "./low-memory-alert.ts";
import type { ReleasePick } from "./idle-subprocess-release.ts";

const log = createLogger("memory-guard");

/**
 * The server's memory guard, run on every reading the watchdog takes (`onServerPulse`): every
 * minute, every 15 s while free commit is under the warn threshold.
 *
 * On each reading it releases the subprocesses of chats that have been quiet too long (and, under
 * the block threshold, a few more), and tells the user — push, Telegram, ntfy, the "Low memory"
 * notification — when free commit drops under the warn or the block threshold, naming the chat
 * whose processes grew fastest across the last readings and how many MCP server processes run.
 * The heavy-command gate (`heavy-command-gate.ts`) reads the same thresholds.
 */

export interface MemoryGuardDeps {
  settings: () => MemoryGuardSettings;
  release: (opts: { idleMinutes: number; memoryLow: boolean }) => ReleasePick[];
  /** The chat's title and project, for the notification. */
  chatInfo: (sessionId: string) => { title: string | null; project: string | null } | null;
  notify: (n: { title: string; body: string; sessionId: string; project: string }) => void;
}

export class MemoryGuard {
  private level: AlertLevel = 0;
  private readonly recent: PulseSample[] = [];

  constructor(private readonly deps: MemoryGuardDeps) {}

  onPulse(sample: PulseSample): void {
    this.recent.push(sample);
    if (this.recent.length > 4) this.recent.shift();
    const s = this.deps.settings();
    const commit = sample.commit;
    const memoryLow = !!commit && belowFreeGB(commit.freeMB, s.blockFreeGB);
    let released: ReleasePick[] = [];
    try {
      released = this.deps.release({ idleMinutes: s.idleCliReleaseMinutes, memoryLow });
    } catch (e) {
      log.warn(`releasing quiet subprocesses failed: ${(e as Error).message}`);
    }
    if (!commit) return;
    const next = nextAlertLevel(this.level, commit.freeMB, s.warnFreeGB, s.blockFreeGB);
    this.level = next.level;
    if (!next.notify || next.level === 0) return;

    const growth = fastestGrowth(this.recent);
    const growthChat = growth?.session ? this.deps.chatInfo(growth.session) : null;
    const { title, body } = lowMemoryMessage({
      freeMB: commit.freeMB, limitMB: commit.limitMB, level: next.level, blockGB: s.blockFreeGB,
      growth, growthChat, mcpServers: sample.mcpServers, released: released.length,
    });
    log.warn(`${title} (${describeCommit(commit)}) — ${body}`);
    this.deps.notify({ title, body, sessionId: growth?.session ?? "", project: growthChat?.project ?? "" });
  }
}

/** Wire the guard to the live server: the watchdog's readings, the chat registry, notifications. */
export async function startMemoryGuard(): Promise<void> {
  const { onServerPulse } = await import("../memory-watchdog.ts");
  const { configService } = await import("../config.service.ts");
  const { releaseQuietSubprocesses } = await import("../../server/ws/chat.ts");
  const { getSessionTitle, getSessionProjectName } = await import("../db.service.ts");
  const { notificationService } = await import("../notification.service.ts");
  const guard = new MemoryGuard({
    settings: () => memoryGuardSettings(configService.get("ai") as never),
    release: (opts) => releaseQuietSubprocesses(opts),
    chatInfo: (sessionId) => {
      try {
        return { title: getSessionTitle(sessionId), project: getSessionProjectName(sessionId) };
      } catch {
        return null;
      }
    },
    notify: ({ title, body, sessionId, project }) => {
      void notificationService.broadcast("memory", { title, body, sessionId, project }, { ownKey: "memory-low" });
    },
  });
  onServerPulse((sample) => guard.onPulse(sample));
}
