/**
 * The files a chat session's shell commands changed, for the session's review.
 *
 * A file tool names its file, so its "before" is read just ahead of the write
 * (`captureBaseline`). A shell command names nothing: `cp`, `sed -i`, `printf >>`, a formatter
 * or a generator can write anywhere, and the review used to list none of those files. So each
 * command is bracketed with `git status` of the repositories it can reach, and a file whose
 * status or stat moved across the command is a file it changed. A status costs ~6 ms on this
 * repository and on an nxsys worktree (measured), and never takes `index.lock`, because the
 * command being tracked may be running git itself.
 *
 * The "before" of such a file comes from one of two places. A file git already listed
 * (modified, staged, untracked) is read before the command runs and held until it ends. A file
 * git did not list was identical to HEAD, so it is read from HEAD afterwards, through
 * `cat-file --filters`: under `core.autocrlf` the blob has LF and the checked-out file CRLF,
 * and the raw blob would diff every line. Every changed file, "before" kept or not, also gets
 * the command's two states in its history (`session-file-history.ts`), which is what puts the
 * command's turn on the blocks it wrote.
 *
 * Not seen, by design: files git ignores, files outside any repository, and anything a
 * background command writes after its tool call returns. A file git ignored until the command
 * un-ignored it is not taken for one the command created unless its ctime says the command
 * touched it, so one the command both writes in place and un-ignores still reads as created. A
 * file another process changes while the command runs is put on the command, except one a file
 * tool of another session wrote in that time. A HEAD move is followed, because a command that
 * edits and commits leaves its files clean; one that rewrites more than HEAD_MOVE_MAX_FILES
 * files (a branch switch, a pull) is not, since those files came from commits rather than from
 * the command.
 */
import { existsSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { isCredentialPath } from "../fs-credential-path-guard.ts";
import { realPathOrSelf } from "../fs-ops/fs-real-path.ts";
import { observeFile } from "./session-file-history.ts";
import {
  BASELINE_MAX_BYTES,
  hasBaseline,
  isValidBaselineSessionId,
  recordBaseline,
  type BaselineSource,
} from "./session-file-baselines.service.ts";

/** A status that takes longer belongs to a repository too big to bracket every command with. */
const GIT_TIMEOUT_MS = 5_000;
/** More entries than any status worth reading; past it the repository is left alone. */
const MAX_STATUS_ENTRIES = 20_000;
/** Bytes of listed files read ahead of one command, across its repositories. */
const PREIMAGE_BUDGET_BYTES = 32 * 1024 * 1024;
/** Repositories bracketed per command: its directory, the ones it names, the session's own. */
const MAX_REPOS = 6;
const MAX_SESSION_REPOS = 4;
const MAX_RECORDS_PER_COMMAND = 500;
const HEAD_MOVE_MAX_FILES = 200;
/** A command whose end never arrived (a denied call, a dead CLI) is forgotten after this. */
const PENDING_TTL_MS = 60 * 60_000;
/** How long a repository that timed out or overflowed is skipped. */
const SLOW_REPO_PAUSE_MS = 10 * 60_000;

/** One path git listed. `worktreeOid` is set when the file on disk is that index blob. */
interface StatusEntry { worktreeOid?: string }

export interface RepoStatus {
  /** HEAD's commit, or null on a branch with no commit yet. */
  head: string | null;
  /** Keyed by repository-relative path, `/`-separated, as git prints it. */
  entries: Map<string, StatusEntry>;
}

/** A listed file as it was before the command. `image` is absent when it was not read. */
interface Before { sig: string; image?: BaselineSource }

interface RepoSnapshot { top: string; status: RepoStatus; before: Map<string, Before> }

interface Pending { sessionId: string; toolUseId: string; startedAt: number; repos: RepoSnapshot[] }

const pending = new Map<string, Pending>();
/** Repositories each session has worked in, most recent first. */
const sessionRepos = new Map<string, string[]>();
/** The last file-tool write of each path: which session, and when. */
const fileToolWrites = new Map<string, { sessionId: string; at: number }>();
const pausedRepos = new Map<string, number>();

/** The repository holding `path`: the nearest directory at or above it with a `.git`. */
export function repoTopOf(path: string): string | null {
  let dir = resolve(path);
  while (!existsSync(dir)) {
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  for (;;) {
    // A home directory kept in git (dotfiles) would make every status walk the whole home.
    if (existsSync(join(dir, ".git"))) return dir === homedir() || dir === parse(dir).root ? null : dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/**
 * The paths a command names, resolved against its directory: the targets of `cd`, `pushd`
 * and `-C`, and every word that looks like a path. A guess, and only used to pick which
 * repositories to bracket, so a word that is not a path costs nothing but a lookup.
 */
export function commandPaths(command: string, cwd: string): string[] {
  const out: string[] = [];
  let dirNext = false;
  for (const m of command.matchAll(/"([^"]*)"|'([^']*)'|([^\s;&|()<>`]+)/g)) {
    if (out.length >= 32) break;
    const quoted = m[1] !== undefined || m[2] !== undefined;
    let word = m[1] ?? m[2] ?? m[3] ?? "";
    if (!quoted && (word === "cd" || word === "pushd" || word === "-C")) {
      dirNext = true;
      continue;
    }
    const named = dirNext;
    dirNext = false;
    const eq = word.indexOf("=");
    if (!named && word.startsWith("-") && eq > 0) word = word.slice(eq + 1);
    if (!word || word.startsWith("$") || word.startsWith("-")) continue;
    if (!named && !word.includes("/") && !word.includes("\\") && !word.startsWith("~")) continue;
    if (word === "~" || word.startsWith("~/")) word = join(homedir(), word.slice(1));
    else if (word.startsWith("~")) continue;
    out.push(isAbsolute(word) ? word : resolve(cwd, word));
  }
  return out;
}

/** `git status --porcelain=v2 -z --branch` output; null past MAX_STATUS_ENTRIES. */
export function parseStatus(out: Uint8Array): RepoStatus | null {
  const records = new TextDecoder().decode(out).split("\0");
  let head: string | null = null;
  const entries = new Map<string, StatusEntry>();
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]!;
    if (rec.startsWith("# branch.oid ")) {
      const oid = rec.slice("# branch.oid ".length);
      head = /^[0-9a-f]{40,64}$/.test(oid) ? oid : null;
    } else if (rec.startsWith("? ")) {
      // A nested repository is listed as a directory; its files are its own repository's.
      if (!rec.endsWith("/")) entries.set(rec.slice(2), {});
    } else if (rec[0] === "1" || rec[0] === "2" || rec[0] === "u") {
      const f = rec.split(" ");
      const path = f.slice(rec[0] === "1" ? 8 : rec[0] === "2" ? 9 : 10).join(" ");
      if (rec[0] === "2") i++; // a rename's source path follows as a record of its own
      if (f[2]?.startsWith("S")) continue; // a submodule
      const xy = f[1] ?? "";
      const indexOid = rec[0] === "1" ? f[7] : undefined;
      const onDisk = xy[1] === "." && xy[0] !== "D" && indexOid && !/^0+$/.test(indexOid);
      entries.set(path, onDisk ? { worktreeOid: indexOid } : {});
    }
    if (entries.size > MAX_STATUS_ENTRIES) return null;
  }
  return { head, entries };
}

const REPO_ENV_KEYS = new Set([
  "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_PREFIX",
]);

function gitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !REPO_ENV_KEYS.has(k)) env[k] = v;
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_TERMINAL_PROMPT = "0";
  // Reading a blob through its filters must not download a Git LFS object.
  env.GIT_LFS_SKIP_SMUDGE = "1";
  return env;
}

/**
 * stdin goes in as bytes, never through `proc.stdin`: a FileSink writing to a git that has
 * already exited rejects with EPIPE where no `catch` reaches it (measured: 2 unhandled
 * rejections in 3 runs against `git --bogus-option`, none with bytes), and three unhandled
 * rejections a minute stop the server.
 */
function spawnGit(cwd: string, args: string[], stdin: string) {
  return Bun.spawn(["git", ...args], { cwd, env: gitEnv(), stdin: new TextEncoder().encode(stdin), stdout: "pipe", stderr: "ignore" });
}

interface GitRun { ok: boolean; out: Uint8Array; truncated: boolean; timedOut: boolean }

async function git(cwd: string, args: string[], opts: { stdin?: string; maxBytes?: number } = {}): Promise<GitRun> {
  let proc: ReturnType<typeof spawnGit>;
  try {
    proc = spawnGit(cwd, args, opts.stdin ?? "");
  } catch {
    // Bun.spawn throws, rather than failing the run, when git is not on PATH.
    return { ok: false, out: new Uint8Array(), truncated: false, timedOut: false };
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, GIT_TIMEOUT_MS);
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  const reader = proc.stdout.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    if (size > (opts.maxBytes ?? Number.POSITIVE_INFINITY)) {
      truncated = true;
      proc.kill();
      reader.cancel().catch(() => {});
      break;
    }
  }
  const code = await proc.exited;
  clearTimeout(timer);
  return { ok: !timedOut && (truncated || code === 0), out: Buffer.concat(chunks), truncated, timedOut };
}

function pause(top: string, why: string): void {
  if (!pausedRepos.has(top)) console.warn(`[session-baselines] not tracking shell changes in ${top} for 10 min: ${why}`);
  pausedRepos.set(top, Date.now() + SLOW_REPO_PAUSE_MS);
}

function isPaused(top: string): boolean {
  const until = pausedRepos.get(top);
  if (until === undefined) return false;
  if (until > Date.now()) return true;
  pausedRepos.delete(top);
  return false;
}

async function readStatus(top: string): Promise<RepoStatus | null> {
  const run = await git(top, [
    "status", "--porcelain=v2", "-z", "--branch", "--no-ahead-behind",
    "--untracked-files=all", "--no-renames", "--ignore-submodules=all",
  ]);
  if (run.timedOut) pause(top, `git status took over ${GIT_TIMEOUT_MS / 1000} s`);
  if (!run.ok) return null;
  const status = parseStatus(run.out);
  if (!status) pause(top, `git status listed over ${MAX_STATUS_ENTRIES} files`);
  return status;
}

async function pool<T>(items: T[], size: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) await run(items[next++]!);
  }));
}

/** A file's identity on disk, to tell whether a command wrote it; "-" when it is missing. */
async function signature(path: string): Promise<string> {
  try {
    const st = await lstat(path, { bigint: true });
    return `${st.mode}:${st.size}:${st.mtimeNs}:${st.ctimeNs}:${st.ino}`;
  } catch {
    return "-";
  }
}

/**
 * Whether the file at `path` is one nothing created, wrote, renamed or chmodded since `since`:
 * its ctime is older. Not its birth time: a file moved into a new path (`mv`, `git mv`) keeps
 * an older one, and is a file the command created there.
 */
async function unchangedSince(path: string, since: number): Promise<boolean> {
  try {
    return (await lstat(path)).ctimeMs < since;
  } catch {
    return false;
  }
}

/** A listed file before the command: its signature, and its bytes while the budget lasts. */
async function readBefore(path: string, budget: { left: number }): Promise<Before> {
  const sig = await signature(path);
  try {
    const st = await lstat(path);
    // git keeps a symlink's target, not a file's content: nothing to show as a before.
    if (!st.isFile()) return { sig };
    if (st.size > BASELINE_MAX_BYTES) return { sig, image: "tooLarge" };
    if (st.size > budget.left) return { sig };
    budget.left -= st.size;
    return { sig, image: new Uint8Array(await readFile(path)) };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? { sig, image: null } : { sig };
  }
}

function rememberRepo(sessionId: string, top: string): void {
  const list = [top, ...(sessionRepos.get(sessionId) ?? []).filter((t) => t !== top)].slice(0, MAX_SESSION_REPOS);
  sessionRepos.delete(sessionId);
  sessionRepos.set(sessionId, list);
  if (sessionRepos.size > 256) sessionRepos.delete(sessionRepos.keys().next().value!);
}

/**
 * A file tool of `sessionId` is writing `path`. Its repository is one the session's later
 * commands are bracketed in, and a command of another session running meanwhile does not
 * take the file.
 */
export function noteFileToolWrite(sessionId: string, path: string): void {
  const abs = resolve(path);
  fileToolWrites.delete(abs);
  fileToolWrites.set(abs, { sessionId, at: Date.now() });
  if (fileToolWrites.size > 5000) fileToolWrites.delete(fileToolWrites.keys().next().value!);
  const top = repoTopOf(abs);
  if (top) rememberRepo(sessionId, top);
}

function candidateRepos(sessionId: string, cwd: string | undefined, command: string | undefined): string[] {
  const tops: string[] = [];
  const add = (top: string | null) => {
    if (top && !tops.includes(top) && !isPaused(top)) tops.push(top);
  };
  const cwdTop = cwd ? repoTopOf(cwd) : null;
  add(cwdTop);
  if (cwd && command) for (const path of commandPaths(command, cwd)) add(repoTopOf(path));
  for (const top of sessionRepos.get(sessionId) ?? []) add(top);
  if (cwdTop) rememberRepo(sessionId, cwdTop);
  return tops.slice(0, MAX_REPOS);
}

async function snapshotRepo(top: string, budget: { left: number }): Promise<RepoSnapshot | null> {
  const status = await readStatus(top);
  if (!status) return null;
  const before = new Map<string, Before>();
  await pool([...status.entries.keys()], 16, async (rel) => {
    const abs = resolve(top, rel);
    // Read even when the session already kept a "before": the command's own goes in the history.
    if (isCredentialPath(abs)) return;
    before.set(rel, await readBefore(abs, budget));
  });
  return { top, status, before };
}

const pendingKey = (sessionId: string, toolUseId: string) => `${sessionId}\0${toolUseId}`;

/** Before a shell command runs: the status of every repository it can reach. Never throws. */
export async function beginShellCommand(p: { sessionId: string; toolUseId: string; cwd?: string; command?: string }): Promise<void> {
  if (!isValidBaselineSessionId(p.sessionId) || !p.toolUseId) return;
  const startedAt = Date.now();
  for (const [key, job] of pending) if (startedAt - job.startedAt > PENDING_TTL_MS) pending.delete(key);
  try {
    const budget = { left: PREIMAGE_BUDGET_BYTES };
    const tops = candidateRepos(p.sessionId, p.cwd, p.command);
    const repos = (await Promise.all(tops.map((top) => snapshotRepo(top, budget))))
      .filter((r): r is RepoSnapshot => r !== null);
    if (repos.length > 0) pending.set(pendingKey(p.sessionId, p.toolUseId), { sessionId: p.sessionId, toolUseId: p.toolUseId, startedAt, repos });
  } catch (e) {
    console.warn(`[session-baselines] shell snapshot failed: ${(e as Error).message}`);
  }
}

/** Paths that differ between two commits, or null when there are too many to be the command's. */
async function changedBetween(top: string, from: string, to: string): Promise<string[] | null> {
  const run = await git(top, ["diff", "--name-only", "-z", "--no-renames", "--ignore-submodules=all", from, to], { maxBytes: 1024 * 1024 });
  if (!run.ok || run.truncated) return null;
  const paths = new TextDecoder().decode(run.out).split("\0").filter(Boolean);
  return paths.length > HEAD_MOVE_MAX_FILES ? null : paths;
}

/** Each path's blob in `head`: the blob, null when the commit has no such file, absent if unknown. */
async function blobsAt(top: string, head: string, rels: string[]): Promise<Map<string, { oid: string; size: number } | null>> {
  const out = new Map<string, { oid: string; size: number } | null>();
  // One `<commit>:<path>` per line: a path with a newline in it cannot be asked for.
  const asked = rels.filter((r) => !r.includes("\n"));
  if (asked.length === 0) return out;
  const run = await git(top, ["cat-file", "--batch-check"], { stdin: asked.map((r) => `${head}:${r}\n`).join("") });
  if (!run.ok) return out;
  const lines = new TextDecoder().decode(run.out).split("\n");
  asked.forEach((rel, i) => {
    const line = lines[i] ?? "";
    const m = /^([0-9a-f]{40,64}) (\w+) (\d+)$/.exec(line);
    if (m) {
      if (m[2] === "blob") out.set(rel, { oid: m[1]!, size: Number(m[3]) });
    } else if (line.endsWith(" missing")) {
      out.set(rel, null);
    }
  });
  return out;
}

async function settleRepo(job: Pending, repo: RepoSnapshot, room: number): Promise<string[]> {
  const after = await readStatus(repo.top);
  if (!after) return [];
  const { sessionId } = job;
  // Written by another session's file tool while the command ran: that change is not this one's.
  const foreign = (abs: string) => {
    const write = fileToolWrites.get(abs);
    return !!write && write.sessionId !== sessionId && write.at >= job.startedAt;
  };
  /** Each file the command changed, and what it held before where that is known. */
  const changed = new Map<string, BaselineSource | undefined>();
  /** Clean before the command, so identical to HEAD then. */
  const clean: string[] = [];

  for (const rel of new Set([...repo.status.entries.keys(), ...after.entries.keys()])) {
    if (changed.size >= room) break;
    const abs = resolve(repo.top, rel);
    if (foreign(abs)) continue;
    if (!repo.status.entries.has(rel)) {
      clean.push(rel);
      continue;
    }
    const was = repo.before.get(rel);
    if (!was || (await signature(abs)) === was.sig) continue;
    changed.set(abs, was.image);
  }

  const head = repo.status.head;
  if (head && after.head && after.head !== head) {
    for (const rel of (await changedBetween(repo.top, head, after.head)) ?? []) {
      if (!repo.status.entries.has(rel) && !after.entries.has(rel) && !foreign(resolve(repo.top, rel))) clean.push(rel);
    }
  }
  if (clean.length > 0) {
    const blobs: Map<string, { oid: string; size: number } | null> = head
      ? await blobsAt(repo.top, head, clean)
      : new Map(clean.map((rel) => [rel, null]));
    await pool(clean, 8, async (rel) => {
      if (changed.size >= room) return;
      const blob = blobs.get(rel);
      if (blob === undefined) return;
      // Only the index moved (`git rm --cached`, `git reset --soft`): the file still holds HEAD's blob.
      if (blob && after.entries.get(rel)?.worktreeOid === blob.oid) return;
      let source: BaselineSource = null;
      if (blob && blob.size > BASELINE_MAX_BYTES) source = "tooLarge";
      else if (blob) {
        const run = await git(repo.top, ["cat-file", "--filters", `--path=${rel}`, blob.oid], { maxBytes: BASELINE_MAX_BYTES });
        if (!run.ok) return;
        source = run.truncated ? "tooLarge" : run.out;
      } else if (await unchangedSince(resolve(repo.top, rel), job.startedAt)) {
        // Not listed, not in HEAD, and untouched by the command: git ignored it until the command
        // rewrote a `.gitignore` or ran `git add -f`. Kept as created, a Revert would delete it.
        return;
      }
      changed.set(resolve(repo.top, rel), source);
    });
  }

  // The first "before" of a file is the session's; every command's two states go in its history.
  const recorded: string[] = [];
  for (const [abs, source] of changed) {
    if (isCredentialPath(await realPathOrSelf(abs))) continue;
    if (source !== undefined) {
      if (!hasBaseline(sessionId, abs) && recordBaseline(sessionId, abs, source)) recorded.push(abs);
      await observeFile(sessionId, abs, job.toolUseId, "before", source);
    }
    await observeFile(sessionId, abs, job.toolUseId, "after");
  }
  return recorded;
}

/**
 * After a shell command ends, however it ended: keep a "before" for each file it changed that
 * the session had none for, and the command's two states of every file it changed in that
 * file's history. Returns the files given a "before". Never throws.
 */
export async function endShellCommand(p: { sessionId: string; toolUseId: string }): Promise<string[]> {
  const key = pendingKey(p.sessionId, p.toolUseId);
  const job = pending.get(key);
  if (!job) return [];
  pending.delete(key);
  const recorded: string[] = [];
  for (const repo of job.repos) {
    try {
      recorded.push(...await settleRepo(job, repo, MAX_RECORDS_PER_COMMAND - recorded.length));
    } catch (e) {
      console.warn(`[session-baselines] shell changes in ${repo.top} not read: ${(e as Error).message}`);
    }
  }
  if (recorded.length > 0) console.log(`[session-baselines] session=${p.sessionId} shell command changed ${recorded.length} file(s)`);
  return recorded;
}

/** Test seam: forget every pending command, remembered repository and file-tool write. */
export function _resetShellChangeTracker(): void {
  pending.clear();
  sessionRepos.clear();
  fileToolWrites.clear();
  pausedRepos.clear();
}
