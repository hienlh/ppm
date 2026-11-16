/**
 * Where a handed-off chat's transcript is, without ever stopping the server to find it. A Claude
 * chat's file is named after its project and id, so it is resolved directly. A Codex chat's rollout
 * is found through the shared async rollout index (`codex-rollout-index.ts`), never through the
 * synchronous lookup that falls back to opening every rollout on disk — on a host with thousands of
 * rollouts that cost seconds of frozen event loop, and a chat that has not run yet misses every time.
 * A miss is remembered for a while, a hit until its file is gone.
 */
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { resolveSessionTranscript } from "../../session-turns/session-turn-index.service.ts";
import { indexedRollouts } from "../../../providers/codex-app-server/codex-rollout-index.ts";
import { codexSessionsDirs } from "../../../providers/codex-app-server/codex-provider.ts";
import { projectKey as keyOf } from "../../project-name-for-path.ts";
import { SESSION_ID_RE } from "../../agent-transcript/session-ownership.ts";

export interface TranscriptLocation {
  path: string;
  /** Where a Claude chat's subagents write their own transcripts (absent for Codex). */
  subagentsDir: string | null;
}

export function createTranscriptLocator(now: () => number = Date.now) {
  const found = new Map<string, TranscriptLocation>();
  const misses = new Map<string, number>();

  async function codexRollout(sessionId: string, projectPath: string): Promise<string | null> {
    const want = keyOf(projectPath);
    for (const dir of codexSessionsDirs(sessionId)) {
      const hit = (await indexedRollouts(dir)).find((r) => r.header?.id === sessionId && !r.header.parentThreadId);
      // Fail closed, as the ownership check does: a rollout of another folder is not this chat's.
      if (hit && hit.header?.cwd && keyOf(hit.header.cwd) === want) return hit.file;
    }
    return null;
  }

  return {
    /** The chat's transcript, or null when it has none yet (asked again after `retryMs`). */
    async locate(sessionId: string, providerId: string, projectPath: string, retryMs: number): Promise<TranscriptLocation | null> {
      if (!SESSION_ID_RE.test(sessionId)) return null;
      const key = `${providerId}\u0000${sessionId}`;
      const known = found.get(key);
      if (known && existsSync(known.path)) return known;
      found.delete(key);
      if ((misses.get(key) ?? 0) > now()) return null;
      let location: TranscriptLocation | null = null;
      try {
        if (providerId === "codex") {
          const path = await codexRollout(sessionId, projectPath);
          location = path ? { path, subagentsDir: null } : null;
        } else {
          const path = resolveSessionTranscript({ providerId: "claude", sessionId, projectPath }).path;
          location = (await stat(path).then(() => true, () => false)) ? { path, subagentsDir: path.replace(/\.jsonl$/, "/subagents") } : null;
        }
      } catch {
        location = null;
      }
      if (location) {
        found.set(key, location);
        misses.delete(key);
      } else {
        misses.set(key, now() + retryMs);
      }
      return location;
    },
  };
}
