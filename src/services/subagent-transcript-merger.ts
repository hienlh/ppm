/**
 * SubagentTranscriptMerger — restore Agent/Task card children on reload.
 *
 * Newer Claude Code CLIs no longer write subagent activity into the main
 * session JSONL (no isSidechain lines, no parent_tool_use_id). Instead each
 * agent gets its own transcript at:
 *   ~/.claude/projects/<slug>/<sessionId>/subagents/agent-<id>.jsonl
 * with a sibling agent-<id>.meta.json carrying the spawning Agent tool_use id
 * (session-spawned agents) or the spawning agent's id (nested agents).
 *
 * Without merging these, a reloaded session shows bare Agent cards and the
 * live-streamed children are lost. This module groups the transcripts under
 * their session-level card, parses each one, and attaches the events — every
 * nesting level flattened into one time-ordered list — as the card's children.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChatEvent } from "../types/chat.ts";
import { parseSessionMessage } from "./jsonl-transcript-parser.ts";
import { groupSubagentsByCard } from "./team-member-activity/subagent-transcript-index.ts";

/**
 * Locate the per-session directory (…/projects/<slug>/<sessionId>) that holds
 * subagents/. The SDK encodes the cwd by replacing separators, drive colon
 * and dots with "-" (`…\ppm\.claude\worktrees\x` → `…-ppm--claude-worktrees-x`);
 * when that drifts (drive-letter case), fall back to scanning project dirs for
 * the session's main JSONL.
 */
export function resolveSessionDir(sessionId: string, projectPath: string | null | undefined): string | null {
  const home = homedir();
  const projectsRoot = join(home, ".claude", "projects");
  if (projectPath) {
    const encoded = projectPath.replace(/[/\\:.]/g, "-");
    const dir = join(projectsRoot, encoded);
    if (existsSync(join(dir, `${sessionId}.jsonl`))) return join(dir, sessionId);
  }
  try {
    for (const entry of readdirSync(projectsRoot)) {
      if (existsSync(join(projectsRoot, entry, `${sessionId}.jsonl`))) {
        return join(projectsRoot, entry, sessionId);
      }
    }
  } catch {
    /* projects root unreadable */
  }
  return null;
}

interface MessageLike {
  content: string;
  events?: ChatEvent[];
}

/** Payload guards — a session can hold dozens of agents with multi-MB transcripts. */
const MAX_CHILDREN_PER_AGENT = 2000;
const MAX_CHILD_OUTPUT_CHARS = 50_000;

/** One child event plus the transcript record time it came from (epoch ms). */
export interface TimedChatEvent {
  ts: number;
  ev: ChatEvent;
}

/**
 * Incremental parser for one agent transcript. Feed it JSONL lines in file
 * order (whole file at once, or a live tail's new lines) and it returns the
 * child events those lines carry, keeping the skip/limit state across calls.
 */
export function createAgentTranscriptLineParser() {
  let isFirstUser = true;
  let emitted = 0;
  let lastTs = 0;
  return {
    feed(line: string): TimedChatEvent[] {
      const out: TimedChatEvent[] = [];
      const trimmed = line.trim();
      if (!trimmed || emitted >= MAX_CHILDREN_PER_AGENT) return out;
      let entry: any;
      try {
        entry = JSON.parse(trimmed);
      } catch {
        return out;
      }
      if (entry.type !== "user" && entry.type !== "assistant") return out;
      if (!entry.message) return out;
      // The first user record is the agent's spawn prompt — the live stream
      // never showed it as a child, so skip it to match the streaming view.
      if (entry.type === "user" && isFirstUser) {
        isFirstUser = false;
        const content = entry.message?.content;
        const hasToolResult = Array.isArray(content) && content.some((b: any) => b?.type === "tool_result");
        if (!hasToolResult) return out;
      }
      // Records without a timestamp inherit the previous one so file order holds.
      const parsedTs = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
      if (!Number.isNaN(parsedTs)) lastTs = parsedTs;
      const parsed = parseSessionMessage(entry);
      for (const ev of parsed.events ?? []) {
        if (emitted >= MAX_CHILDREN_PER_AGENT) break;
        // Keep single events from ballooning the history payload (agent files
        // can carry multi-MB tool outputs the live stream also showed in full,
        // but 24 agents × full outputs breaks mobile reloads).
        if (ev.type === "tool_result" && typeof ev.output === "string" && ev.output.length > MAX_CHILD_OUTPUT_CHARS) {
          ev.output = ev.output.slice(0, MAX_CHILD_OUTPUT_CHARS) + "\n… [truncated]";
        }
        out.push({ ts: lastTs, ev });
        emitted++;
      }
      return out;
    },
  };
}

/** Parse one whole agent transcript into timed child events (file order). */
export function parseAgentTranscriptTimed(filePath: string): TimedChatEvent[] {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const parser = createAgentTranscriptLineParser();
  const out: TimedChatEvent[] = [];
  for (const line of text.split("\n")) out.push(...parser.feed(line));
  return out;
}

/** Parse one agent transcript into a flat children event list (stream order). */
export function parseAgentTranscript(filePath: string): ChatEvent[] {
  return parseAgentTranscriptTimed(filePath).map((t) => t.ev);
}

/**
 * Attach subagent transcript events as children of their Agent/Task cards.
 * `sessionDir` is the per-session directory next to the main JSONL
 * (…/projects/<slug>/<sessionId>). A card's group — the agent it spawned plus
 * any agents that one spawned in turn — is merged into one list ordered by
 * record time, so a nested worker's steps read where they happened rather
 * than after the parent agent's conclusion. Existing children are replaced —
 * the disk transcripts are the complete record, while live-collected children
 * may be a partial overlap. Mutates messages in-place.
 */
export function mergeSubagentChildren(sessionDir: string, messages: MessageLike[]): void {
  const groups = groupSubagentsByCard(join(sessionDir, "subagents"));
  if (groups.size === 0) return;

  for (const msg of messages) {
    for (const ev of msg.events ?? []) {
      if (ev.type !== "tool_use" || (ev.tool !== "Agent" && ev.tool !== "Task") || !ev.toolUseId) continue;
      const group = groups.get(ev.toolUseId);
      if (!group) continue;
      const timed: TimedChatEvent[] = [];
      for (const agent of group) timed.push(...parseAgentTranscriptTimed(agent.transcriptPath));
      // Stable sort: same-timestamp events keep transcript order.
      timed.sort((a, b) => a.ts - b.ts);
      if (timed.length > 0) ev.children = timed.map((t) => t.ev);
    }
  }
}
