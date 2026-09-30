/**
 * "Who is running right now" for one session, for the running-agents bar.
 * Liveness is decided from transcript write time on disk, never from chat
 * state in memory — the same signal `member-activity.service.ts` already uses
 * for the team panel, so a resumed, backgrounded or reopened session reads the
 * same way as one still streaming live.
 */
import { join } from "node:path";
import { getCachedSubagentGroups } from "./agent-transcript-index-cache.ts";
import { scanCodexDescendants } from "./agent-transcript-codex-activity.ts";
import { indexTranscriptsByMember } from "../team-member-activity/subagent-transcript-index.ts";
import { summarizeTranscriptTail } from "../team-member-activity/transcript-tail-summary.ts";
import { subagentCardId } from "../../providers/codex-app-server/codex-subagent-thread.ts";
import type { OwnedSession } from "./session-ownership.ts";
import { ACTIVITY_WINDOW_MS, type AgentTranscriptRunningEntry } from "../../shared/agent-transcript-protocol.ts";

function lastStepLabel(tail: Awaited<ReturnType<typeof summarizeTranscriptTail>>): string | undefined {
  return tail.lastNarrative ?? tail.lastTool;
}

async function claudeActivity(owned: OwnedSession, now: number): Promise<AgentTranscriptRunningEntry[]> {
  const subagentsDir = join(owned.claude!.sessionDir, "subagents");
  const groups = getCachedSubagentGroups(subagentsDir);
  const out: AgentTranscriptRunningEntry[] = [];

  for (const [cardId, entries] of groups) {
    let newest = entries[0];
    for (const e of entries) if (e.modifiedAt > newest!.modifiedAt) newest = e;
    if (!newest || now - newest.modifiedAt > ACTIVITY_WINDOW_MS) continue;
    const tail = await summarizeTranscriptTail(newest.transcriptPath);
    out.push({ cardId, lastWriteAt: newest.modifiedAt, lastStep: lastStepLabel(tail) });
  }

  // A team is itself a session: its members carry no toolUseId (they are not
  // card-spawned), so they never appear in `groups` above and need their own pass.
  for (const [memberName, entry] of indexTranscriptsByMember(subagentsDir)) {
    if (!entry.sizeBytes || now - entry.modifiedAt > ACTIVITY_WINDOW_MS) continue;
    const tail = await summarizeTranscriptTail(entry.transcriptPath);
    out.push({ memberName, lastWriteAt: entry.modifiedAt, lastStep: lastStepLabel(tail) });
  }

  return out;
}

function codexActivity(owned: OwnedSession, now: number): AgentTranscriptRunningEntry[] {
  const { path, dirs } = owned.codex!;
  const descendants = scanCodexDescendants(path, dirs, owned.projectPath);
  const out: AgentTranscriptRunningEntry[] = [];
  for (const d of descendants) {
    if (d.done && now - d.lastWriteAt > ACTIVITY_WINDOW_MS) continue;
    out.push({ cardId: subagentCardId(d.threadId), lastWriteAt: d.lastWriteAt, lastStep: d.lastStep });
  }
  return out;
}

export async function computeRunningAgents(owned: OwnedSession, now: number): Promise<AgentTranscriptRunningEntry[]> {
  return owned.providerId === "claude" ? claudeActivity(owned, now) : codexActivity(owned, now);
}
