/**
 * SubagentTranscriptMerger — restore Agent/Task card children on reload.
 *
 * Newer Claude Code CLIs no longer write subagent activity into the main
 * session JSONL (no isSidechain lines, no parent_tool_use_id). Instead each
 * agent gets its own transcript at:
 *   ~/.claude/projects/<slug>/<sessionId>/subagents/agent-<id>.jsonl
 * with a sibling agent-<id>.meta.json carrying the spawning Agent tool_use id.
 *
 * Without merging these, a reloaded session shows bare Agent cards and the
 * live-streamed children are lost. This module reads the meta files, parses
 * each agent transcript, and attaches its events as the card's children.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChatEvent } from "../types/chat.ts";
import { parseSessionMessage } from "./jsonl-transcript-parser.ts";

/**
 * Locate the per-session directory (…/projects/<slug>/<sessionId>) that holds
 * subagents/. The SDK encodes the cwd by replacing separators + drive colon
 * with "-"; when that drifts (drive-letter case), fall back to scanning
 * project dirs for the session's main JSONL.
 */
export function resolveSessionDir(sessionId: string, projectPath: string | null | undefined): string | null {
  const home = homedir();
  const projectsRoot = join(home, ".claude", "projects");
  if (projectPath) {
    const encoded = projectPath.replace(/[/\\:]/g, "-");
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

/** Map of Agent-card toolUseId → agent transcript path, from subagents/*.meta.json */
function indexAgentTranscripts(subagentsDir: string): Map<string, string> {
  const map = new Map<string, string>();
  let entries: string[];
  try {
    entries = readdirSync(subagentsDir);
  } catch {
    return map;
  }
  for (const name of entries) {
    if (!name.endsWith(".meta.json")) continue;
    try {
      const meta = JSON.parse(readFileSync(join(subagentsDir, name), "utf8"));
      const toolUseId = meta?.toolUseId as string | undefined;
      if (!toolUseId) continue;
      const transcript = join(subagentsDir, name.replace(/\.meta\.json$/, ".jsonl"));
      if (existsSync(transcript)) map.set(toolUseId, transcript);
    } catch {
      /* unreadable meta — skip this agent */
    }
  }
  return map;
}

/** Parse one agent transcript into a flat children event list (stream order). */
function parseAgentTranscript(filePath: string): ChatEvent[] {
  const children: ChatEvent[] = [];
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    return children;
  }
  let isFirstUser = true;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: any;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (entry.type !== "user" && entry.type !== "assistant") continue;
    if (!entry.message) continue;
    if (children.length >= MAX_CHILDREN_PER_AGENT) break;
    // The first user record is the agent's spawn prompt — the live stream
    // never showed it as a child, so skip it to match the streaming view.
    if (entry.type === "user" && isFirstUser) {
      isFirstUser = false;
      const content = entry.message?.content;
      const hasToolResult = Array.isArray(content) && content.some((b: any) => b?.type === "tool_result");
      if (!hasToolResult) continue;
    }
    const parsed = parseSessionMessage(entry);
    for (const ev of parsed.events ?? []) {
      // Keep single events from ballooning the history payload (agent files
      // can carry multi-MB tool outputs the live stream also showed in full,
      // but 24 agents × full outputs breaks mobile reloads).
      if (ev.type === "tool_result" && typeof ev.output === "string" && ev.output.length > MAX_CHILD_OUTPUT_CHARS) {
        ev.output = ev.output.slice(0, MAX_CHILD_OUTPUT_CHARS) + "\n… [truncated]";
      }
      children.push(ev);
    }
  }
  return children;
}

/**
 * Attach subagent transcript events as children of their Agent/Task cards.
 * `sessionDir` is the per-session directory next to the main JSONL
 * (…/projects/<slug>/<sessionId>). Existing children are replaced — the disk
 * transcript is the complete record, while live-collected children may be a
 * partial overlap. Mutates messages in-place.
 */
export function mergeSubagentChildren(sessionDir: string, messages: MessageLike[]): void {
  const index = indexAgentTranscripts(join(sessionDir, "subagents"));
  if (index.size === 0) return;

  for (const msg of messages) {
    for (const ev of msg.events ?? []) {
      if (ev.type !== "tool_use" || (ev.tool !== "Agent" && ev.tool !== "Task") || !ev.toolUseId) continue;
      const transcript = index.get(ev.toolUseId);
      if (!transcript) continue;
      const children = parseAgentTranscript(transcript);
      if (children.length > 0) ev.children = children;
    }
  }
}
