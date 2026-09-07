/**
 * Index a session's subagent transcripts by teammate name.
 *
 * Claude Code writes one transcript per spawned agent at
 *   ~/.claude/projects/<slug>/<sessionId>/subagents/agent-<id>.jsonl
 * with a sibling `agent-<id>.meta.json` carrying `{ agentType, description,
 * name, toolUseId, model }`. That `name` is the same handle the team inbox uses
 * (`dev-p1`, `lead`, …), which is what lets a team member be joined to the
 * transcript of the work it actually did.
 *
 * A team's inbox only records the task it was handed; the transcript is the sole
 * record of what it then did, so this index is the bridge between the two.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface SubagentTranscriptEntry {
  /** Teammate handle from the meta file; absent for unnamed one-off agents. */
  name?: string;
  /** Registered agent type, e.g. `ak-engineer:fullstack-developer`. */
  agentType?: string;
  /** Spawn-time description of the job. */
  description?: string;
  /** Model the agent ran on, when the meta records one. */
  model?: string;
  /** tool_use id of the spawning Agent call — links back to the chat card. */
  toolUseId?: string;
  /** Raw id from the `agent-<id>` file stem — the form `parentAgentId` uses. */
  agentId: string;
  /**
   * agentId of the agent that spawned this one. Set on nested agents (a
   * subagent that itself called Agent/Skill); those metas carry no toolUseId
   * because the spawning tool_use lives in the parent agent's transcript, not
   * the session's.
   */
  parentAgentId?: string;
  /** Absolute path of the agent's JSONL transcript. */
  transcriptPath: string;
  /** Transcript size in bytes — the cheap "how much work" signal. */
  sizeBytes: number;
  /** Last write time in epoch ms — the cheap "is it still running" signal. */
  modifiedAt: number;
}

/** Read every `*.meta.json` in a subagents dir, paired with its transcript. */
export function listSubagentTranscripts(subagentsDir: string): SubagentTranscriptEntry[] {
  let entries: string[];
  try {
    entries = readdirSync(subagentsDir);
  } catch {
    return []; // no subagents dir — session never spawned an agent
  }

  const out: SubagentTranscriptEntry[] = [];
  for (const file of entries) {
    if (!file.endsWith(".meta.json")) continue;
    const transcriptPath = join(subagentsDir, file.replace(/\.meta\.json$/, ".jsonl"));
    if (!existsSync(transcriptPath)) continue;
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(readFileSync(join(subagentsDir, file), "utf8"));
    } catch {
      /* unreadable meta — still surface the transcript, just unlabelled */
    }
    let sizeBytes = 0;
    let modifiedAt = 0;
    try {
      const st = statSync(transcriptPath);
      sizeBytes = st.size;
      modifiedAt = st.mtimeMs;
    } catch {
      /* raced with a delete — treat as empty */
    }
    out.push({
      name: typeof meta.name === "string" ? meta.name : undefined,
      agentType: typeof meta.agentType === "string" ? meta.agentType : undefined,
      description: typeof meta.description === "string" ? meta.description : undefined,
      model: typeof meta.model === "string" ? meta.model : undefined,
      toolUseId: typeof meta.toolUseId === "string" ? meta.toolUseId : undefined,
      agentId: file.replace(/^agent-/, "").replace(/\.meta\.json$/, ""),
      parentAgentId: typeof meta.parentAgentId === "string" ? meta.parentAgentId : undefined,
      transcriptPath,
      sizeBytes,
      modifiedAt,
    });
  }
  return out;
}

/**
 * Group every transcript under the session-level Agent card it belongs to.
 *
 * The CLI only stamps `toolUseId` on agents the session itself spawned. A
 * nested agent (spawned by another agent, e.g. a reviewer running a skill that
 * forks its own worker) has only `parentAgentId`, and the SDK streams none of
 * its activity — so the card's transcript group is the only place its work can
 * surface. Walk each chain up to the root and key by that root's toolUseId.
 * Entries are ordered root first, then descendants by depth.
 */
export function groupSubagentsByCard(subagentsDir: string): Map<string, SubagentTranscriptEntry[]> {
  const entries = listSubagentTranscripts(subagentsDir);
  const byId = new Map(entries.map((e) => [e.agentId, e]));
  const rootOf = (entry: SubagentTranscriptEntry): { root: SubagentTranscriptEntry; depth: number } | null => {
    let cur = entry;
    let depth = 0;
    const seen = new Set<string>();
    while (cur.parentAgentId) {
      if (seen.has(cur.agentId)) return null; // cyclic metas — corrupt, skip
      seen.add(cur.agentId);
      const parent = byId.get(cur.parentAgentId);
      if (!parent) return null; // parent meta missing — cannot attach anywhere
      cur = parent;
      depth++;
    }
    return cur.toolUseId ? { root: cur, depth } : null;
  };

  const groups = new Map<string, Array<{ entry: SubagentTranscriptEntry; depth: number }>>();
  for (const entry of entries) {
    const resolved = rootOf(entry);
    if (!resolved) continue;
    const key = resolved.root.toolUseId!;
    const list = groups.get(key) ?? [];
    list.push({ entry, depth: resolved.depth });
    groups.set(key, list);
  }
  const out = new Map<string, SubagentTranscriptEntry[]>();
  for (const [key, list] of groups) {
    list.sort((a, b) => a.depth - b.depth);
    out.set(key, list.map((l) => l.entry));
  }
  return out;
}

/**
 * Newest transcript per teammate name.
 *
 * A retried teammate reuses its handle (`dev-p8`, then `dev-p8b`), but a plain
 * re-spawn under the same name would collide — the most recently written
 * transcript is the one describing current work, so it wins.
 */
export function indexTranscriptsByMember(subagentsDir: string): Map<string, SubagentTranscriptEntry> {
  const byName = new Map<string, SubagentTranscriptEntry>();
  for (const entry of listSubagentTranscripts(subagentsDir)) {
    if (!entry.name) continue;
    const existing = byName.get(entry.name);
    if (!existing || entry.modifiedAt > existing.modifiedAt) byName.set(entry.name, entry);
  }
  return byName;
}
