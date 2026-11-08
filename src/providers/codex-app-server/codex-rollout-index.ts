/**
 * The headers of every rollout in a codex sessions tree, kept between session-list requests.
 *
 * Listing one project's codex sessions means finding which rollouts ran in it, and a sessions
 * tree holds every project's rollouts — on the machine this was measured on, 5,262 files and
 * 5.4 GB across four accounts. Reading their heads synchronously on every list request froze the
 * server for 35–90 s whenever the files had fallen out of the OS cache (10.9 s for one project,
 * and the sidebar asks for two or three at once), which took every other request down with it.
 *
 * So the heads are read once and remembered, keyed by path and re-read only when the file's
 * size or modification time moves; every read is asynchronous, so the disk is waited on by the
 * thread pool rather than by the event loop; and concurrent callers share one pass over a tree.
 *
 * A rollout's head never changes once written — codex appends — so a file that grew keeps the
 * header already read for it unless that header was still missing its title.
 */

import { open, readdir, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { rolloutHeaderReads, type RolloutHeader } from "./codex-rollout-header.ts";

export interface IndexedRollout {
  file: string;
  header: RolloutHeader | null;
  /** Last modification, which is the session's last activity. */
  mtimeMs: number;
}

interface Entry {
  size: number;
  mtimeMs: number;
  header: RolloutHeader | null;
  /** Whether `header.title` has been looked for — it is read only for sessions someone lists. */
  titled: boolean;
}

/** Files read at once. Enough to keep a disk busy without holding thousands of handles. */
const READ_CONCURRENCY = 16;

const entries = new Map<string, Entry>();
const passes = new Map<string, Promise<IndexedRollout[]>>();

/** Every `rollout-*.jsonl` under `dir`, without ever blocking on the disk. */
export async function listRolloutFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  let found;
  try { found = await readdir(dir, { withFileTypes: true }); } catch { return files; }
  for (const entry of found) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await listRolloutFiles(path));
    else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) files.push(path);
  }
  return files;
}

/** `readSessionMeta`, asynchronously: the same slices, read by the thread pool. */
export async function readRolloutHeaderAsync(
  file: string,
  opts?: { withTitle?: boolean },
): Promise<RolloutHeader | null> {
  let handle;
  try {
    handle = await open(file, "r");
    const plan = rolloutHeaderReads((await handle.stat()).size, opts);
    let step = plan.next();
    while (!step.done) {
      const { buffer, offset, length, position } = step.value;
      step = plan.next((await handle.read(buffer, offset, length, position)).bytesRead);
    }
    return step.value;
  } catch {
    return null; // unreadable → excluded, fail-closed like every other rollout read
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function refresh(file: string): Promise<IndexedRollout | null> {
  let stamp;
  try { stamp = await stat(file); } catch { entries.delete(file); return null; }
  const known = entries.get(file);
  if (known && known.size === stamp.size && known.mtimeMs === stamp.mtimeMs) {
    return { file, header: known.header, mtimeMs: known.mtimeMs };
  }
  // Appended to since it was read: the head is the same, so only a header that is still
  // waiting for its title — or was never readable — needs reading again.
  if (known?.header && stamp.size >= known.size && (!known.titled || known.header.title)) {
    known.size = stamp.size;
    known.mtimeMs = stamp.mtimeMs;
    return { file, header: known.header, mtimeMs: known.mtimeMs };
  }
  const header = await readRolloutHeaderAsync(file);
  entries.set(file, { size: stamp.size, mtimeMs: stamp.mtimeMs, header, titled: false });
  return { file, header, mtimeMs: stamp.mtimeMs };
}

async function indexTree(dir: string): Promise<IndexedRollout[]> {
  const files = await listRolloutFiles(dir);
  const present = new Set(files);
  const root = join(dir, sep);
  for (const file of entries.keys()) {
    if (file.startsWith(root) && !present.has(file)) entries.delete(file);
  }
  const out: IndexedRollout[] = [];
  let next = 0;
  async function worker() {
    while (next < files.length) {
      const found = await refresh(files[next++]!);
      if (found) out.push(found);
    }
  }
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, files.length) }, worker));
  return out;
}

/**
 * Every rollout under `dir` with its header. Callers arriving while a pass over the same tree
 * is running get that pass rather than starting a second one.
 */
export function indexedRollouts(dir: string): Promise<IndexedRollout[]> {
  const running = passes.get(dir);
  if (running) return running;
  const pass = indexTree(dir).finally(() => passes.delete(dir));
  passes.set(dir, pass);
  return pass;
}

/**
 * The opening prompt of a rollout already indexed, read on first ask and remembered. Only the
 * sessions on the page being listed are asked for: a title can sit megabytes into a file.
 */
export async function indexedRolloutTitle(file: string): Promise<string | undefined> {
  const entry = entries.get(file);
  if (!entry?.header) return undefined;
  if (entry.titled) return entry.header.title;
  const header = await readRolloutHeaderAsync(file, { withTitle: true });
  if (header) entry.header = header;
  entry.titled = true;
  return entry.header.title;
}

/** Forget everything indexed. For tests, which write fixtures into reused paths. */
export function clearRolloutIndex(): void {
  entries.clear();
}
