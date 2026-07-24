import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { readdir, mkdir, copyFile, rm, stat } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { getPpmDir } from "../ppm-dir.ts";

/** Root of Claude session JSONLs. Overridable via CLAUDE_PROJECTS_DIR for tests. */
function claudeProjectsDir(): string {
  return process.env.CLAUDE_PROJECTS_DIR || resolve(homedir(), ".claude", "projects");
}

/** Reduce a user-supplied group name to a single safe path segment so it can
 *  never escape the archive root (strip separators / `..` / control chars). */
function safeSegment(name: string): string {
  const cleaned = name
    .replace(/[/\\]/g, "_")
    .replace(/\.\./g, "_")
    .replace(/[\x00-\x1f]/g, "")
    .trim();
  return cleaned.length > 0 ? cleaned : "group";
}

function archiveDir(groupName: string): string {
  return join(getPpmDir(), "teams", safeSegment(groupName), "transcripts");
}

export interface ArchiveResult {
  archived: boolean;
  deleted: boolean;
  dest?: string;
  reason?: string;
}

/** Locate `<sessionId>.jsonl` anywhere under the Claude projects root. */
async function findJsonl(sessionId: string): Promise<string | null> {
  const root = claudeProjectsDir();
  let dirs: string[];
  try { dirs = await readdir(root); } catch { return null; }
  for (const d of dirs) {
    if (d.includes("..") || d.includes("/") || d.includes("\\")) continue; // path-safety
    const p = join(root, d, `${sessionId}.jsonl`);
    try { await stat(p); return p; } catch { /* keep looking */ }
  }
  return null;
}

/** Option A+: copy the raw JSONL into the PPM team archive, verify the copy,
 *  then delete the raw file. Idempotent + best-effort (never throws). */
export async function archiveAndDelete(sessionId: string, groupName: string): Promise<ArchiveResult> {
  const src = await findJsonl(sessionId);
  if (!src) return { archived: false, deleted: false, reason: "raw JSONL not found" };

  const dir = archiveDir(groupName);
  const dest = join(dir, `${sessionId}.jsonl`);
  try {
    await mkdir(dir, { recursive: true });
    await copyFile(src, dest);
  } catch (e) {
    return { archived: false, deleted: false, reason: (e as Error).message };
  }

  // Verify the copy exists BEFORE deleting the raw file.
  const copied = await stat(dest).then(() => true).catch(() => false);
  if (!copied) return { archived: false, deleted: false, reason: "copy verification failed" };

  await rm(src, { force: true }).catch(() => { /* best-effort */ });
  const stillThere = await stat(src).then(() => true).catch(() => false);
  return { archived: true, deleted: !stillThere, dest };
}

/** Read an archived transcript's raw JSONL content (powers "view full"). */
export function readArchivedTranscript(sessionId: string, groupName: string): string | null {
  const dest = join(archiveDir(groupName), `${sessionId}.jsonl`);
  if (!existsSync(dest)) return null;
  try { return readFileSync(dest, "utf8"); } catch { return null; }
}
