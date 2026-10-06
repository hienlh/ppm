/**
 * "Who is running right now" for one session, for the running-agents bar.
 * Liveness is decided from transcript write time on disk, never from chat
 * state in memory — the same signal `member-activity.service.ts` already uses
 * for the team panel, so a resumed, backgrounded or reopened session reads the
 * same way as one still streaming live.
 */
import { join } from "node:path";
import { getCachedSubagentGroups, getCachedTranscriptsByMember } from "./agent-transcript-index-cache.ts";
import { scanCodexDescendants } from "./agent-transcript-codex-activity.ts";
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
  const inCard = new Set<string>();

  for (const [cardId, entries] of groups) {
    let newest = entries[0];
    for (const e of entries) {
      inCard.add(e.transcriptPath);
      if (e.modifiedAt > newest!.modifiedAt) newest = e;
    }
    if (!newest || now - newest.modifiedAt > ACTIVITY_WINDOW_MS) continue;
    const tail = await summarizeTranscriptTail(newest.transcriptPath);
    // entries[0] is the agent the card spawned; a name makes it a teammate as well.
    const memberName = entries[0]!.name;
    out.push({ cardId, ...(memberName ? { memberName } : {}), lastWriteAt: newest.modifiedAt, lastStep: lastStepLabel(tail) });
  }

  // A named agent the session spawned has a card too, and was listed above —
  // only a teammate with no card here needs this pass.
  for (const [memberName, entry] of getCachedTranscriptsByMember(subagentsDir)) {
    if (inCard.has(entry.transcriptPath)) continue;
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
    // Age out on staleness alone, not "done AND stale": a child that crashed
    // before ever writing its own completed record would otherwise show as
    // running forever, since `done` would never become true for it.
    if (now - d.lastWriteAt > ACTIVITY_WINDOW_MS) continue;
    out.push({ cardId: subagentCardId(d.threadId), lastWriteAt: d.lastWriteAt, lastStep: d.lastStep });
  }
  return out;
}

/** Test-only: counts calls to `computeRunningAgents`, so a test can prove the
 *  hub computes this once per tick and fans the SAME result out to every
 *  subscriber, rather than recomputing it once per subscriber. */
let callCountForTest = 0;
export function _resetComputeRunningAgentsCallCountForTest(): void {
  callCountForTest = 0;
}
export function _computeRunningAgentsCallCountForTest(): number {
  return callCountForTest;
}

export async function computeRunningAgents(owned: OwnedSession, now: number): Promise<AgentTranscriptRunningEntry[]> {
  callCountForTest++;
  return owned.providerId === "claude" ? claudeActivity(owned, now) : codexActivity(owned, now);
}
