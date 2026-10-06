/**
 * An Undo for discarding working-tree changes.
 *
 * git keeps nothing of a discarded change — no reflog entry, no object — so the
 * only way back is a copy taken here, at the moment it is thrown away:
 *
 * - A block (hunk) discard keeps the patch that was reversed, plus what the
 *   discard left of the file. Undo applies the patch forward again only while
 *   the file is still exactly that: where its lines moved, `git apply` would
 *   look for them elsewhere in the file, and a copy of them there is enough to
 *   put the block back in the wrong place.
 * - A whole-file discard keeps the file's bytes (or the fact it did not exist)
 *   from before, written down *before* anything is discarded, so a discard that
 *   fails or stops half way can still be undone; then what the discard left
 *   behind. Undo writes the bytes back only while every file is still exactly
 *   what the discard left, so it can never overwrite an edit made since. Where
 *   that was never noted (PPM stopped first), a file is written back only while
 *   that loses nothing: it is gone, unchanged, or what the index holds.
 *
 * Entries live in `<ppm dir>/git-discards/<repo key>/` for a day, at most 100
 * per repository. A file over 20 MB is not copied and cannot be restored; the
 * record says so, so the UI never offers an Undo it cannot keep.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  chmod, lstat, mkdir, readdir, readFile, readlink, rename, rm, stat, symlink, unlink, writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ChangeHunk, DiscardRecord } from "../../shared/git-changes.ts";
import { isInsideDir, realPathOrSelf, realPathOrSelfSync } from "../fs-ops/fs-real-path.ts";
import { parsePorcelainV2 } from "../git-changes/porcelain-v2.ts";
import { assertSafeFilePath, LITERAL_PATHSPECS, runGit, toDisplay } from "../git-hunks/git-hunks.service.ts";
import { hunkFingerprint, parseUnifiedDiff } from "../git-hunks/unified-diff.ts";
import { createLogger } from "../logger.ts";
import { getPpmDir } from "../ppm-dir.ts";

const log = createLogger("git");

const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 100;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_ENTRY_BYTES = 100 * 1024 * 1024;
const ID = /^[0-9a-f-]{36}$/;
const BLOB = /^[0-9a-f-]{36}\.\d+\.bin$/;

type FileState =
  | { kind: "missing" }
  | { kind: "file"; mode: number; sha: string }
  | { kind: "symlink"; target: string };

interface FileRecord {
  path: string;
  before: FileState;
  /** The saved bytes, beside the entry, when `before` is a file. */
  blob?: string;
  /** What the discard left; Undo restores only while the file still is this. */
  after?: FileState;
}

interface JournalEntry {
  id: string;
  repo: string;
  createdAt: number;
  kind: "hunks" | "files";
  /** Block discards: the file and the reversed patch, base64. */
  path?: string;
  patch?: string;
  /** Block discards: what the discard left of the file; Undo applies only onto this. */
  after?: FileState;
  /** Whole-file discards. */
  files?: FileRecord[];
  /** Too large to copy; not restored. */
  skipped?: string[];
}

/** A whole-file discard between the copy and the discard itself. */
export interface PendingFileCapture {
  entry: JournalEntry;
  dir: string;
}

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function sameState(a: FileState | undefined, b: FileState): boolean {
  if (!a || a.kind !== b.kind) return false;
  if (a.kind === "file" && b.kind === "file") return a.sha === b.sha && a.mode === b.mode;
  if (a.kind === "symlink" && b.kind === "symlink") return a.target === b.target;
  return true;
}

class GitDiscardJournal {
  private repoRoot(repo: string): string {
    return realPathOrSelfSync(resolve(repo));
  }

  private dirFor(repo: string): string {
    return join(getPpmDir(), "git-discards", sha256(this.repoRoot(repo)).slice(0, 16));
  }

  /**
   * The absolute path for a repository-relative one, refusing anything that
   * leaves the repository or reaches into `.git` — through `..` or through a
   * symlinked directory on the way.
   */
  private async target(root: string, path: string): Promise<string> {
    assertSafeFilePath(path);
    if (path.split(/[\\/]+/)[0] === ".git") throw new Error(`Refusing to touch "${path}".`);
    const abs = resolve(root, path);
    const parent = await realPathOrSelf(dirname(abs));
    if (!isInsideDir(parent, root) || isInsideDir(parent, join(root, ".git"))) {
      throw new Error(`"${path}" is outside the repository.`);
    }
    return abs;
  }

  private async stateOf(abs: string, maxBytes = MAX_FILE_BYTES): Promise<{ state: FileState; bytes?: Buffer } | null> {
    let st;
    try {
      st = await lstat(abs);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { state: { kind: "missing" } };
      throw e;
    }
    if (st.isSymbolicLink()) return { state: { kind: "symlink", target: await readlink(abs) } };
    if (!st.isFile() || st.size > maxBytes) return null;
    const bytes = await readFile(abs);
    return { state: { kind: "file", mode: st.mode & 0o777, sha: sha256(bytes) }, bytes };
  }

  /** Keep the patch a block discard reversed, and what it left of the file. */
  async recordHunks(repo: string, path: string, patch: string): Promise<DiscardRecord> {
    const root = this.repoRoot(repo);
    const after = await this.stateOf(await this.target(root, path), Infinity);
    const entry: JournalEntry = {
      id: randomUUID(),
      repo: root,
      createdAt: Date.now(),
      kind: "hunks",
      path,
      patch: Buffer.from(patch, "latin1").toString("base64"),
      ...(after ? { after: after.state } : {}),
    };
    const dir = this.dirFor(repo);
    await mkdir(dir, { recursive: true });
    await this.writeEntry(dir, entry);
    await this.prune(dir);
    return this.summary(entry);
  }

  /**
   * Copy the files a whole-file discard is about to touch, and write the entry
   * down. Call before discarding: once this returns, a discard that stops half
   * way, PPM included, leaves an entry that can undo what it did.
   */
  async captureFiles(repo: string, paths: string[]): Promise<PendingFileCapture> {
    const root = this.repoRoot(repo);
    const entry: JournalEntry = {
      id: randomUUID(), repo: root, createdAt: Date.now(), kind: "files", files: [], skipped: [],
    };
    const dir = this.dirFor(repo);
    await mkdir(dir, { recursive: true });
    try {
      let total = 0;
      for (const [i, path] of paths.entries()) {
        const read = await this.stateOf(await this.target(root, path));
        if (!read || (read.bytes && total + read.bytes.length > MAX_ENTRY_BYTES)) {
          entry.skipped!.push(path);
          continue;
        }
        const record: FileRecord = { path, before: read.state };
        if (read.bytes) {
          total += read.bytes.length;
          record.blob = `${entry.id}.${i}.bin`;
          await writeFile(join(dir, record.blob), read.bytes);
        }
        entry.files!.push(record);
      }
      await this.writeEntry(dir, entry);
    } catch (e) {
      await this.removeEntry(dir, entry.id).catch(() => undefined);
      throw e;
    }
    return { entry, dir };
  }

  /** Record what the discard left, and keep the entry. */
  async commitFiles(pending: PendingFileCapture): Promise<DiscardRecord> {
    const { entry, dir } = pending;
    for (const record of entry.files!) {
      const read = await this.stateOf(await this.target(entry.repo, record.path));
      if (read) record.after = read.state;
    }
    await this.writeEntry(dir, entry);
    await this.prune(dir);
    return this.summary(entry);
  }

  /** The entry `captureFiles` wrote, as the discard routes answer it. */
  summarize(pending: PendingFileCapture): DiscardRecord {
    return this.summary(pending.entry);
  }

  /**
   * The discard failed. When it changed nothing, the copies go; when it got
   * part way, they are what brings back what it already threw away, so the
   * entry is kept and returned.
   */
  async failed(pending: PendingFileCapture): Promise<DiscardRecord | null> {
    const { entry, dir } = pending;
    try {
      const untouched = await Promise.all(entry.files!.map(async (record) => {
        const now = await this.stateOf(await this.target(entry.repo, record.path));
        return !!now && sameState(record.before, now.state);
      }));
      if (untouched.every(Boolean)) {
        await this.removeEntry(dir, entry.id);
        return null;
      }
      const record = await this.commitFiles(pending);
      log.warn(`a discard in ${entry.repo} failed part way; discard ${entry.id} can put back what it already removed`);
      return record;
    } catch (e) {
      // The entry written before the discard is still there, and can still undo it.
      log.error(`could not tell what the failed discard ${entry.id} in ${entry.repo} changed; keeping its copies:`, e);
      return this.summary(entry);
    }
  }

  async list(repo: string): Promise<DiscardRecord[]> {
    const dir = this.dirFor(repo);
    await this.prune(dir);
    const entries = await this.readEntries(dir);
    const root = this.repoRoot(repo);
    return entries
      .filter((e) => e.repo === root)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((e) => this.summary(e));
  }

  /** Put a discard back. Throws, restoring nothing, when that would overwrite a later change. */
  async undo(repo: string, id: string): Promise<{ paths: string[] }> {
    if (!ID.test(id)) throw new Error("Unknown discard.");
    const dir = this.dirFor(repo);
    const entry = await this.readEntry(dir, id);
    const root = this.repoRoot(repo);
    if (!entry || entry.repo !== root) throw new Error("This discard can no longer be undone.");

    if (entry.kind === "hunks") {
      // Onto exactly what the discard left, or not at all: `git apply` takes a
      // block whose lines moved to wherever else in the file they also appear.
      const now = await this.stateOf(await this.target(root, entry.path!), Infinity);
      if (!now || !sameState(entry.after, now.state)) {
        throw new Error(`${entry.path} was edited after this change was discarded, so it cannot be put back.`);
      }
      const patch = Buffer.from(entry.patch ?? "", "base64");
      const res = await runGit(root, ["apply", "-"], { stdin: patch });
      if (res.exitCode !== 0) throw new Error(res.stderr.trim() || "git could not put the change back.");
      await this.removeEntry(dir, id);
      log.info(`restored discard ${id} in ${root} (hunks of ${entry.path})`);
      return { paths: [entry.path!] };
    }

    const files = entry.files ?? [];
    const targets = await Promise.all(files.map((f) => this.target(root, f.path)));
    // Never noted (PPM stopped before it could): only what git can give back may be overwritten.
    const unnoted = files.filter((f) => !f.after).map((f) => f.path);
    const unlike = unnoted.length ? await this.unlikeIndex(root, unnoted) : new Set<string>();
    // Check every file before writing any: all or nothing.
    const unchanged: boolean[] = [];
    for (const [i, record] of files.entries()) {
      const now = await this.stateOf(targets[i]!);
      unchanged[i] = !!now && sameState(record.before, now.state);
      const safe = !!now && (record.after
        ? sameState(record.after, now.state)
        : unchanged[i] || now.state.kind === "missing" || !unlike.has(record.path));
      if (!safe) {
        throw new Error(`${record.path} changed after it was discarded, so Undo would overwrite that. Nothing was restored.`);
      }
    }
    let at = 0;
    try {
      for (const [i, record] of files.entries()) {
        at = i;
        // Never discarded (the discard failed first): nothing to put back.
        if (unchanged[i]) continue;
        const abs = targets[i]!;
        const before = record.before;
        // Never write *through* whatever is there now.
        await unlink(abs).catch((e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; });
        if (before.kind === "missing") continue;
        await mkdir(dirname(abs), { recursive: true });
        if (before.kind === "symlink") {
          await symlink(before.target, abs);
        } else {
          if (!record.blob || !BLOB.test(record.blob)) throw new Error("The saved copy of this file is missing.");
          await writeFile(abs, await readFile(join(dir, record.blob)));
          await chmod(abs, before.mode);
        }
      }
    } catch (e) {
      // The files before this one are back; this one was unlinked first, so it may now be gone.
      log.error(`undo of discard ${id} in ${root} failed at ${files[at]!.path} after restoring ${at}/${files.length} file(s):`, e);
      throw e;
    }
    await this.removeEntry(dir, id);
    log.info(`restored discard ${id} in ${root} (${files.length} path(s))`);
    return { paths: files.map((f) => f.path) };
  }

  private summary(entry: JournalEntry): DiscardRecord {
    const record: DiscardRecord = {
      id: entry.id,
      createdAt: entry.createdAt,
      kind: entry.kind,
      paths: entry.kind === "hunks" ? [entry.path!] : (entry.files ?? []).map((f) => f.path),
    };
    if (entry.skipped?.length) record.skipped = entry.skipped;
    if (entry.kind === "hunks" && entry.patch) {
      const parsed = parseUnifiedDiff(Buffer.from(entry.patch, "base64").toString("latin1"));
      record.hunks = parsed.hunks.map((hunk, index): ChangeHunk => ({
        id: hunkFingerprint(hunk),
        index,
        oldStart: hunk.oldStart,
        oldLines: hunk.oldLines,
        newStart: hunk.newStart,
        newLines: hunk.newLines,
        added: hunk.lines.filter((l) => l.kind === "+").length,
        removed: hunk.lines.filter((l) => l.kind === "-").length,
        heading: toDisplay(hunk.heading),
        lines: hunk.lines.map((l) => (l.noNewline
          ? { kind: l.kind, text: toDisplay(l.text), noNewline: true }
          : { kind: l.kind, text: toDisplay(l.text) })),
      }));
    }
    return record;
  }

  /** Write an entry whole or not at all: a crash mid-write must not lose the one already there. */
  private async writeEntry(dir: string, entry: JournalEntry): Promise<void> {
    const file = join(dir, `${entry.id}.json`);
    await writeFile(`${file}.tmp`, JSON.stringify(entry));
    await rename(`${file}.tmp`, file);
  }

  /** Of these paths, those whose working-tree file is not what the index holds. */
  private async unlikeIndex(root: string, paths: string[]): Promise<Set<string>> {
    const res = await runGit(
      root,
      ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignored=matching", "--", ...paths],
      { env: LITERAL_PATHSPECS },
    );
    if (res.exitCode !== 0) throw new Error(res.stderr.trim() || `git status exited with ${res.exitCode}`);
    return new Set(parsePorcelainV2(res.stdout).entries
      .filter((e) => !(e.kind === "ordinary" || e.kind === "renamed") || e.y !== ".")
      .map((e) => toDisplay(e.path)));
  }

  private async readEntry(dir: string, id: string): Promise<JournalEntry | null> {
    try {
      return JSON.parse(await readFile(join(dir, `${id}.json`), "utf8")) as JournalEntry;
    } catch {
      return null;
    }
  }

  private async readEntries(dir: string): Promise<JournalEntry[]> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }
    const entries = await Promise.all(
      names.filter((n) => n.endsWith(".json")).map((n) => this.readEntry(dir, n.slice(0, -5))),
    );
    return entries.filter((e): e is JournalEntry => e !== null);
  }

  private async removeEntry(dir: string, id: string): Promise<void> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    await Promise.all(names.filter((n) => n.startsWith(`${id}.`)).map((n) => rm(join(dir, n), { force: true })));
  }

  /**
   * Drop entries older than a day, and all but the newest 100 — and, once a
   * day old, files no entry names: the copies of a capture PPM stopped in the
   * middle of, whose entry was never written. A day, because a capture still
   * running has written its copies and not yet its entry.
   */
  private async prune(dir: string): Promise<void> {
    const entries = (await this.readEntries(dir)).sort((a, b) => b.createdAt - a.createdAt);
    const now = Date.now();
    const stale = entries.filter((e, i) => i >= MAX_ENTRIES || now - e.createdAt > MAX_AGE_MS);
    for (const e of stale) await this.removeEntry(dir, e.id);
    const kept = new Set(entries.filter((e) => !stale.includes(e)).map((e) => e.id));
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (kept.has(name.slice(0, name.indexOf(".")))) continue;
      const file = join(dir, name);
      const st = await stat(file).catch(() => null);
      if (st && now - st.mtimeMs > MAX_AGE_MS) await rm(file, { force: true });
    }
  }
}

export const gitDiscardJournal = new GitDiscardJournal();
