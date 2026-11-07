import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import type { ChatMessage, SessionInfo } from "../provider.interface.ts";
import { compareSessionsByActivity } from "../../types/chat.ts";
import { getSessionProjectPath } from "../../services/db.service.ts";
import { resolveAntigravityPaths } from "./antigravity-connection.ts";
import {
  cleanAntigravityUserInput,
  extractSubagentIdFromOutput,
  parseAntigravityTranscriptSteps,
  type AntigravityTranscriptStep,
} from "./antigravity-transcript-parser.ts";

const SAFE_SESSION_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export interface AntigravityTranscriptLocation {
  transcriptPath: string;
  fullTranscriptPath?: string;
  brainDir: string;
}

/** Find the on-disk `transcript.jsonl` for an Antigravity conversation ID. */
export function findAntigravityTranscriptPath(
  sessionId: string,
  brainDirs?: string[],
): AntigravityTranscriptLocation | null {
  if (!SAFE_SESSION_ID_RE.test(sessionId)) return null;
  const dirs = brainDirs ?? resolveAntigravityPaths().brainDirs;
  for (const brainDir of dirs) {
    const logsDir = join(brainDir, sessionId, ".system_generated", "logs");
    const transcriptPath = join(logsDir, "transcript.jsonl");
    if (existsSync(transcriptPath)) {
      const fullCandidate = join(logsDir, "transcript_full.jsonl");
      return {
        transcriptPath,
        ...(existsSync(fullCandidate) ? { fullTranscriptPath: fullCandidate } : {}),
        brainDir,
      };
    }
  }
  return null;
}

function normalizePathForMatch(p: string): string {
  const resolved = resolve(p).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

interface SummaryEntry {
  workspacePaths: string[];
  isSubagent: boolean;
}

function uriToFsPath(u: string): string {
  if (/^file:\/\//i.test(u)) {
    try {
      return fileURLToPath(u);
    } catch { /* fallback */ }
  }
  return decodeURIComponent(u.replace(/^file:\/\//i, ""));
}

function loadSummaryEntriesForBrainDir(brainDir: string): Map<string, SummaryEntry> | null {
  const dbPath = join(dirname(brainDir), "conversation_summaries.db");
  if (!existsSync(dbPath)) return null;
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const rows = db
      .query(
        "SELECT conversation_id, workspace_uris, parent_conversation_id, nesting_depth FROM conversation_summaries",
      )
      .all() as Array<{
      conversation_id: string;
      workspace_uris: string;
      parent_conversation_id: string;
      nesting_depth: number;
    }>;
    const map = new Map<string, SummaryEntry>();
    for (const row of rows) {
      let uris: string[] = [];
      try {
        const parsed = JSON.parse(row.workspace_uris || "[]");
        if (Array.isArray(parsed)) uris = parsed.filter((u): u is string => typeof u === "string");
      } catch { /* ignore */ }
      const workspacePaths = uris
        .map(uriToFsPath)
        .filter(Boolean)
        .map(normalizePathForMatch);
      map.set(row.conversation_id, {
        workspacePaths,
        isSubagent: Boolean(row.parent_conversation_id) || Number(row.nesting_depth) > 0,
      });
    }
    return map;
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

/**
 * Determine whether an Antigravity transcript belongs to `projectPath`.
 * Uses Antigravity's native `conversation_summaries.db` workspace mapping when available,
 * then PPM's recorded session->project mapping, then path-boundary transcript fallback.
 */
export function isAntigravitySessionInProject(
  sessionId: string,
  transcriptPath: string,
  projectPath: string,
  summaryMap?: Map<string, SummaryEntry> | null,
): boolean {
  const normProject = normalizePathForMatch(projectPath);

  // Authoritative check from Antigravity's own conversation_summaries.db when present
  const brainDir = dirname(dirname(dirname(dirname(transcriptPath))));
  const summaries = summaryMap !== undefined ? summaryMap : loadSummaryEntriesForBrainDir(brainDir);
  const summary = summaries?.get(sessionId);
  if (summary) {
    if (summary.isSubagent) return false;
    if (summary.workspacePaths.length > 0) {
      return summary.workspacePaths.includes(normProject);
    }
  }

  try {
    const recorded = getSessionProjectPath(sessionId);
    if (recorded) {
      return normalizePathForMatch(recorded) === normProject;
    }
  } catch { /* DB may not be initialized in isolated unit tests */ }

  try {
    const raw = readFileSync(transcriptPath, "utf-8");
    const cwdMatch = /Command Working Directory:\s*([^\r\n"\\]+)/i.exec(raw);
    if (cwdMatch?.[1]) {
      const normCwd = normalizePathForMatch(cwdMatch[1].trim());
      return normCwd === normProject || normCwd.startsWith(`${normProject}/`);
    }
    const haystack = process.platform === "win32" ? raw.toLowerCase() : raw;
    const escaped = normProject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const boundaryRe = new RegExp(`${escaped}(?:[/\\\\"\\r\\n]|$)`);
    return boundaryRe.test(haystack);
  } catch {
    return false;
  }
}

const historyCache = new Map<string, { stamp: string; messages: ChatMessage[] }>();
const sessionMetaCache = new Map<string, { stamp: string; title: string; createdAt: string; updatedAt: string }>();

function fileStamp(filePath: string): string | null {
  try {
    const st = statSync(filePath);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return null;
  }
}

/** Disk stamp for an Antigravity transcript (for HTTP history caching). */
export function antigravityTranscriptStamp(sessionId: string, brainDirs?: string[]): string | null {
  const loc = findAntigravityTranscriptPath(sessionId, brainDirs);
  if (!loc) return null;
  const compactStamp = fileStamp(loc.transcriptPath);
  if (!compactStamp) return null;
  const fullStamp = loc.fullTranscriptPath ? fileStamp(loc.fullTranscriptPath) ?? "" : "";
  return `${compactStamp}|${fullStamp}`;
}

/** Extract the conversation title from an Antigravity session's `transcript.jsonl`. */
export function extractAntigravitySessionTitle(
  sessionId: string,
  brainDirs?: string[],
): string | undefined {
  const loc = findAntigravityTranscriptPath(sessionId, brainDirs);
  if (!loc) return undefined;
  const stamp = fileStamp(loc.transcriptPath);
  const cached = stamp ? sessionMetaCache.get(loc.transcriptPath) : null;
  if (cached && cached.stamp === stamp && !cached.title.startsWith("Antigravity ")) {
    return cached.title;
  }
  try {
    const content = readFileSync(loc.transcriptPath, "utf-8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      const step = JSON.parse(line) as AntigravityTranscriptStep;
      if (step.type === "USER_INPUT" && step.content) {
        const cleaned = cleanAntigravityUserInput(step.content);
        const firstLine = cleaned.split("\n").find((l) => l.trim().length > 0)?.trim();
        if (firstLine) {
          return firstLine.slice(0, 80);
        }
      }
    }
  } catch { /* ignore */ }
  return undefined;
}

/** List Antigravity sessions discovered under `~/.gemini/antigravity/brain/`. */
export async function listAntigravitySessions(
  providerId: string,
  opts?: { projectPath?: string; brainDirs?: string[] },
): Promise<SessionInfo[]> {
  const dirs = opts?.brainDirs ?? resolveAntigravityPaths().brainDirs;
  const seen = new Set<string>();
  const spawnedSubagents = new Set<string>();
  const candidates: Array<{ sessionId: string; loc: AntigravityTranscriptLocation }> = [];

  for (const brainDir of dirs) {
    if (!existsSync(brainDir)) continue;
    const summaryMap = loadSummaryEntriesForBrainDir(brainDir);
    let entries: string[];
    try {
      entries = readdirSync(brainDir);
    } catch {
      continue;
    }

    for (const sessionId of entries) {
      if (!SAFE_SESSION_ID_RE.test(sessionId) || seen.has(sessionId)) continue;
      if (summaryMap?.get(sessionId)?.isSubagent) continue;
      const loc = findAntigravityTranscriptPath(sessionId, [brainDir]);
      if (!loc) continue;
      for (const subId of extractSubagentIdsFromTranscript(loc.transcriptPath, sessionId)) {
        spawnedSubagents.add(subId);
      }
      if (opts?.projectPath && !isAntigravitySessionInProject(sessionId, loc.transcriptPath, opts.projectPath, summaryMap)) {
        continue;
      }
      seen.add(sessionId);
      candidates.push({ sessionId, loc });
    }
  }

  const sessions: SessionInfo[] = [];
  for (const { sessionId, loc } of candidates) {
    if (spawnedSubagents.has(sessionId)) continue;

    const stamp = fileStamp(loc.transcriptPath);
    const cachedMeta = stamp ? sessionMetaCache.get(loc.transcriptPath) : null;
    if (cachedMeta && cachedMeta.stamp === stamp) {
      sessions.push({
        id: sessionId,
        providerId,
        title: cachedMeta.title,
        createdAt: cachedMeta.createdAt,
        updatedAt: cachedMeta.updatedAt,
      });
      continue;
    }

    let title = `Antigravity ${sessionId.slice(0, 8)}`;
    let createdAt = new Date().toISOString();
    let updatedAt = createdAt;

    try {
      const st = statSync(loc.transcriptPath);
      updatedAt = st.mtime.toISOString();
      createdAt = (st.birthtime && st.birthtimeMs > 0 ? st.birthtime : st.mtime).toISOString();
    } catch { /* use defaults */ }

    try {
      const content = readFileSync(loc.transcriptPath, "utf-8");
      const lines = content.split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        const step = JSON.parse(line) as AntigravityTranscriptStep;
        if (step.created_at && step.step_index === 0) {
          createdAt = step.created_at;
        }
        if (step.type === "USER_INPUT" && step.content) {
          const cleaned = cleanAntigravityUserInput(step.content);
          const firstLine = cleaned.split("\n").find((l) => l.trim().length > 0)?.trim();
          if (firstLine) {
            title = firstLine.slice(0, 80);
            break;
          }
        }
      }
    } catch { /* keep default title */ }

    if (stamp) {
      sessionMetaCache.set(loc.transcriptPath, { stamp, title, createdAt, updatedAt });
    }

    sessions.push({
      id: sessionId,
      providerId,
      title,
      createdAt,
      updatedAt,
    });
  }

  return sessions.sort(compareSessionsByActivity);
}

/** Load chat messages from an Antigravity conversation's `transcript.jsonl`. */
export async function loadAntigravityHistory(
  sessionId: string,
  opts?: { brainDirs?: string[]; _depth?: number; _seen?: Set<string> },
): Promise<ChatMessage[]> {
  const depth = opts?._depth ?? 0;
  const seen = opts?._seen ?? new Set<string>();
  if (depth > 2 || seen.has(sessionId)) return [];
  seen.add(sessionId);

  const loc = findAntigravityTranscriptPath(sessionId, opts?.brainDirs);
  if (!loc) return [];

  const stamp = antigravityTranscriptStamp(sessionId, opts?.brainDirs);
  if (depth === 0 && stamp) {
    const hit = historyCache.get(loc.transcriptPath);
    if (hit && hit.stamp === stamp) return hit.messages;
  }

  try {
    const raw = readFileSync(loc.transcriptPath, "utf-8");
    const lines = raw.split("\n");
    let fullLines: string[] | undefined;
    if (loc.fullTranscriptPath && raw.includes('"truncated_fields"')) {
      try {
        fullLines = readFileSync(loc.fullTranscriptPath, "utf-8").split("\n");
      } catch { /* fallback to compact lines */ }
    }
    const messages = parseAntigravityTranscriptSteps(lines, fullLines, sessionId);
    if (depth < 2) {
      for (const msg of messages) {
        for (const ev of msg.events ?? []) {
          if (ev.type === "tool_use" && ev.tool === "Agent" && ev.toolUseId?.startsWith("subagent-")) {
            const subId = ev.toolUseId.slice("subagent-".length);
            const subMsgs = await loadAntigravityHistory(subId, {
              brainDirs: opts?.brainDirs,
              _depth: depth + 1,
              _seen: seen,
            });
            const childEvents = subMsgs.flatMap((m) => m.events ?? []);
            if (childEvents.length > 0) {
              ev.children = childEvents;
              ev.transcriptAvailable = true;
            }
          }
        }
      }
    }
    if (depth === 0 && stamp) {
      if (historyCache.size >= 64) {
        const firstKey = historyCache.keys().next().value;
        if (firstKey) historyCache.delete(firstKey);
      }
      historyCache.set(loc.transcriptPath, { stamp, messages });
    }
    return messages;
  } catch (err) {
    console.warn(`[antigravity-history] Failed to load session ${sessionId}:`, err);
    return [];
  }
}

/**
 * Extract subagent conversation IDs spawned via `invoke_subagent` in a parent transcript.
 * Used by `/ws/global` `agent-transcript-sources.ts` to verify descendant ownership.
 */
export function extractSubagentIdsFromTranscript(
  transcriptPath: string,
  parentSessionId?: string,
): Set<string> {
  const subagents = new Set<string>();
  const ownerId =
    parentSessionId ??
    /[/\\]brain[/\\]([0-9a-f-]{36})[/\\]/i.exec(transcriptPath)?.[1];
  try {
    const raw = readFileSync(transcriptPath, "utf-8");
    if (!raw.includes("invoke_subagent")) return subagents;
    const lines = raw.split("\n");
    const pendingIsSubagent: boolean[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const step = JSON.parse(line) as AntigravityTranscriptStep;
        if (step.type === "PLANNER_RESPONSE" && Array.isArray(step.tool_calls)) {
          pendingIsSubagent.length = 0;
          for (const c of step.tool_calls) {
            pendingIsSubagent.push(c.name === "invoke_subagent");
          }
        } else if (step.type === "GENERIC" && (step.source === "MODEL" || step.source === "SYSTEM" || !step.source)) {
          const isSub = pendingIsSubagent.shift() ?? false;
          if (isSub && typeof step.content === "string") {
            const subId = extractSubagentIdFromOutput(step.content, ownerId);
            if (subId && (!ownerId || subId.toLowerCase() !== ownerId.toLowerCase())) {
              subagents.add(subId);
            }
          }
        }
      } catch { /* skip malformed line */ }
    }
  } catch { /* unreadable file */ }
  return subagents;
}
