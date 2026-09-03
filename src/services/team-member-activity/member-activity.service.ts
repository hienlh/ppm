/**
 * Per-teammate live activity for the team panel.
 *
 * Answers the two questions the inbox cannot: *is anyone working right now*, and
 * *how far along are they*. Neither is derivable from `~/.claude/teams/<team>/`
 * — every member there reads "active" forever, because an inbox only records the
 * task it was handed. The signal lives in the agent transcripts instead: a
 * transcript being appended to right now is a teammate working right now.
 */

import { join } from "node:path";
import { resolveSessionDir } from "../subagent-transcript-merger.ts";
import { indexTranscriptsByMember, type SubagentTranscriptEntry } from "./subagent-transcript-index.ts";
import { summarizeTranscriptTail } from "./transcript-tail-summary.ts";
import { scanOutboundMessages, type OutboundTeamMessage } from "./outbound-message-scanner.ts";

/** A transcript touched within this window means the agent is mid-work. */
export const WORKING_WINDOW_MS = 90_000;

export type MemberWorkState = "working" | "paused" | "no-transcript";

export interface TeamMemberActivity {
  name: string;
  /** `working` while the transcript is being appended to, else `paused`. */
  workState: MemberWorkState;
  agentType?: string;
  model?: string;
  /** Spawn-time description of the job. */
  description?: string;
  /** tool_use id of the spawning Agent call — links to the chat card. */
  toolUseId?: string;
  startedAt?: string;
  lastEventAt?: string;
  /** Latest tool the agent ran, and its headline argument. */
  lastTool?: string;
  lastToolArg?: string;
  /** Latest prose the agent wrote about its own progress. */
  lastNarrative?: string;
  /** Transcript size — a rough "how much work happened" measure. */
  sizeBytes: number;
}

/** Locate a team's subagents dir. An implicit team is named after its session. */
export function resolveTeamSubagentsDir(teamName: string, projectPath?: string | null): string | null {
  const sessionDir = resolveSessionDir(teamName, projectPath);
  return sessionDir ? join(sessionDir, "subagents") : null;
}

function workStateFor(entry: SubagentTranscriptEntry, now: number): MemberWorkState {
  if (!entry.sizeBytes) return "no-transcript";
  return now - entry.modifiedAt <= WORKING_WINDOW_MS ? "working" : "paused";
}

/**
 * Activity for every teammate that has a transcript, newest work first.
 *
 * Only head/tail slices are read per member, so this stays cheap enough to poll
 * while the panel is open.
 */
export async function readTeamMemberActivity(
  teamName: string,
  projectPath?: string | null,
): Promise<TeamMemberActivity[]> {
  const subagentsDir = resolveTeamSubagentsDir(teamName, projectPath);
  if (!subagentsDir) return [];
  const byMember = indexTranscriptsByMember(subagentsDir);
  const now = Date.now();

  const rows = await Promise.all(
    [...byMember.entries()].map(async ([name, entry]) => {
      const tail = await summarizeTranscriptTail(entry.transcriptPath);
      return {
        name,
        workState: workStateFor(entry, now),
        agentType: entry.agentType,
        model: entry.model,
        description: entry.description,
        toolUseId: entry.toolUseId,
        sizeBytes: entry.sizeBytes,
        ...tail,
      } satisfies TeamMemberActivity;
    }),
  );

  // Whoever is working belongs at the top; within a group, most recent first.
  return rows.sort((a, b) => {
    if (a.workState !== b.workState) return a.workState === "working" ? -1 : b.workState === "working" ? 1 : 0;
    return (b.lastEventAt ?? "").localeCompare(a.lastEventAt ?? "");
  });
}

/** Every reply teammates sent out, across the team's transcripts. */
export async function readTeamOutboundMessages(
  teamName: string,
  projectPath?: string | null,
): Promise<OutboundTeamMessage[]> {
  const subagentsDir = resolveTeamSubagentsDir(teamName, projectPath);
  if (!subagentsDir) return [];
  const byMember = indexTranscriptsByMember(subagentsDir);
  const batches = await Promise.all(
    [...byMember.entries()].map(([name, entry]) => scanOutboundMessages(entry.transcriptPath, name)),
  );
  return batches
    .flat()
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
}

/** Transcript path for one teammate, or null when it has none. */
export function resolveMemberTranscript(
  teamName: string,
  memberName: string,
  projectPath?: string | null,
): string | null {
  const subagentsDir = resolveTeamSubagentsDir(teamName, projectPath);
  if (!subagentsDir) return null;
  return indexTranscriptsByMember(subagentsDir).get(memberName)?.transcriptPath ?? null;
}
