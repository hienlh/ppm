/**
 * The working tree, file by file and block by block (`GET /git/changes`), and
 * one file with its lines (`GET /git/changes/file`).
 *
 * One `git status` names the files; then at most one `git diff` per side
 * covers all of them — staged (HEAD → index), unstaged (index → working
 * tree), and untracked files through a throwaway index, as `git-hunks` does
 * for one file. Running a diff per file would be hundreds of spawns on a big
 * change set, every few seconds.
 *
 * Every diff uses `PATCH_DIFF_ARGS`, the flags the hunk routes use, so a
 * block's id here is exactly the fingerprint those routes resolve a request by.
 *
 * This runs on a poll and in the background, so it must never take the index
 * lock: `GIT_OPTIONAL_LOCKS=0` stops `git status` refreshing the index, which
 * would otherwise make a user's own `git commit` fail with "index.lock exists"
 * when the two coincide.
 */
import { spawn } from "node:child_process";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ChangeBlock, ChangeHunk, ChangeSide, ChangeSideDetail, ChangedFile, FileChangeDetail,
  GitChanges, LastCommit, WholeReason,
} from "../../shared/git-changes.ts";
import { LITERAL_PATHSPECS, PATCH_DIFF_ARGS, assertSafeFilePath, runGit, toDisplay } from "../git-hunks/git-hunks.service.ts";
import { hunkFingerprint, parseUnifiedDiff, type DiffHunk } from "../git-hunks/unified-diff.ts";
import { DiffSectionSplitter, type DiffSection, type SplitterLimits } from "./diff-sections.ts";
import { readGitOperation } from "./git-operation.ts";
import { parsePorcelainV2, type PorcelainBranch, type PorcelainEntry } from "./porcelain-v2.ts";

const BACKGROUND_ENV = { GIT_OPTIONAL_LOCKS: "0" };

/** Diff text kept per file; past it the file is one "large" block. */
const MAX_SECTION_BYTES = 1024 * 1024;
const LIMITS: SplitterLimits = { maxSectionBytes: MAX_SECTION_BYTES, maxTotalBytes: 24 * 1024 * 1024 };
/** A side with more hunks, or more changed lines, than this is offered whole. */
const MAX_BLOCKS_PER_SIDE = 400;
const MAX_LINES_PER_SIDE = 20_000;
/** Entries listed; a tree with more is reported as truncated. */
const MAX_ENTRIES = 5000;
/** Untracked files diffed for blocks; the rest are listed whole. */
const MAX_UNTRACKED_DIFFED = 400;
/** An untracked file larger than this is listed whole rather than read. */
const MAX_UNTRACKED_BYTES = 4 * 1024 * 1024;

/** Stream a `git diff` straight into the splitter, never holding the whole output. */
function streamDiff(cwd: string, args: string[], env?: Record<string, string>): Promise<DiffSection[]> {
  return new Promise((resolve, reject) => {
    const splitter = new DiffSectionSplitter(LIMITS);
    const child = spawn("git", args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...LITERAL_PATHSPECS, ...BACKGROUND_ENV, ...env },
    });
    const stderr: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => { splitter.push(c.toString("latin1")); });
    child.stderr.on("data", (c: Buffer) => { stderr.push(c); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(splitter.end());
      else reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `git diff exited with ${code}`));
    });
    child.stdin.end();
  });
}

function groupByPath(sections: DiffSection[]): Map<string, DiffSection[]> {
  const map = new Map<string, DiffSection[]>();
  for (const section of sections) {
    const list = map.get(section.path);
    if (list) list.push(section);
    else map.set(section.path, [section]);
  }
  return map;
}

interface DescribedSide {
  whole?: WholeReason;
  hunks: DiffHunk[];
  added: number;
  removed: number;
}

function isSubmoduleSection(section: DiffSection): boolean {
  return section.indexMode === "160000" || section.oldMode === "160000" || section.newMode === "160000";
}

/** Cut one side of one file into blocks, or say why it stays whole. */
function describeSide(sections: DiffSection[] | undefined, entry: PorcelainEntry, letter: string): DescribedSide {
  if (!sections?.length) return { whole: "unread", hunks: [], added: 0, removed: 0 };
  const added = sections.reduce((n, s) => n + s.added, 0);
  const removed = sections.reduce((n, s) => n + s.removed, 0);
  const whole = (reason: WholeReason): DescribedSide => ({ whole: reason, hunks: [], added, removed });

  if (entry.sub.startsWith("S") || sections.some(isSubmoduleSection)) return whole("submodule");
  // A type change is written as a deletion plus a creation of the same path.
  if (letter === "T" || sections.length > 1) return whole("type");
  const section = sections[0]!;
  if (section.binary) return whole("binary");
  if (section.text === null || added + removed > MAX_LINES_PER_SIDE) return whole("large");
  if (section.hunks === 0) {
    if (section.newFile || section.deletedFile) return whole("empty");
    return whole(section.oldMode !== undefined && section.newMode !== undefined ? "mode" : "unread");
  }
  const parsed = parseUnifiedDiff(section.text);
  if (parsed.binary) return whole("binary");
  if (parsed.hunks.length > MAX_BLOCKS_PER_SIDE) return whole("large");
  return { hunks: parsed.hunks, added, removed };
}

function countKind(hunk: DiffHunk, kind: "+" | "-"): number {
  let n = 0;
  for (const line of hunk.lines) if (line.kind === kind) n++;
  return n;
}

function toBlock(hunk: DiffHunk, index: number): ChangeBlock {
  return {
    id: hunkFingerprint(hunk),
    index,
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    added: countKind(hunk, "+"),
    removed: countKind(hunk, "-"),
  };
}

function toSide(described: DescribedSide): ChangeSide {
  const side: ChangeSide = {
    blocks: described.hunks.map(toBlock),
    added: described.added,
    removed: described.removed,
  };
  if (described.whole) side.whole = described.whole;
  return side;
}

function toSideDetail(described: DescribedSide): ChangeSideDetail {
  const hunks: ChangeHunk[] = described.hunks.map((hunk, index) => ({
    ...toBlock(hunk, index),
    heading: toDisplay(hunk.heading),
    lines: hunk.lines.map((line) => (line.noNewline
      ? { kind: line.kind, text: toDisplay(line.text), noNewline: true }
      : { kind: line.kind, text: toDisplay(line.text) })),
  }));
  const detail: ChangeSideDetail = { hunks, added: described.added, removed: described.removed };
  if (described.whole) detail.whole = described.whole;
  return detail;
}

function wholeSide(reason: WholeReason, added = 0, removed = 0): DescribedSide {
  return { whole: reason, hunks: [], added, removed };
}

/** `git diff --numstat -z` with renames on: `added\tremoved\t\0src\0dst\0` per rename. */
export function parseRenameNumstat(output: string): Map<string, { added: number; removed: number }> {
  const counts = new Map<string, { added: number; removed: number }>();
  const tokens = output.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(token);
    if (!m) continue;
    const value = { added: m[1] === "-" ? 0 : Number(m[1]), removed: m[2] === "-" ? 0 : Number(m[2]) };
    if (m[3] === "") {
      // A rename: the next two fields are the source and the destination.
      const destination = tokens[i + 2];
      i += 2;
      if (destination !== undefined) counts.set(destination, value);
    } else {
      counts.set(m[3]!, value);
    }
  }
  return counts;
}

class GitChangesService {
  /**
   * One computation per repository at a time: Source Control, the Review tab
   * and the Git Graph all refresh on the same `git:changed`. A caller joins a
   * running one only if nothing was written since it started, or it would be
   * handed the state from before the write it is refreshing for.
   */
  private readonly inflight = new Map<string, { generation: number; promise: Promise<GitChanges> }>();
  private readonly generations = new Map<string, number>();

  /** Called after any write to the repository through PPM. */
  invalidate(cwd: string): void {
    this.generations.set(cwd, (this.generations.get(cwd) ?? 0) + 1);
  }

  getChanges(cwd: string): Promise<GitChanges> {
    const generation = this.generations.get(cwd) ?? 0;
    const running = this.inflight.get(cwd);
    if (running && running.generation === generation) return running.promise;
    const promise = this.computeChanges(cwd).finally(() => {
      if (this.inflight.get(cwd)?.promise === promise) this.inflight.delete(cwd);
    });
    this.inflight.set(cwd, { generation, promise });
    return promise;
  }

  private async computeChanges(cwd: string): Promise<GitChanges> {
    const res = await runGit(
      cwd,
      ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"],
      { env: BACKGROUND_ENV },
    );
    if (res.exitCode !== 0) throw new Error(res.stderr.trim() || `git status exited with ${res.exitCode}`);
    const status = parsePorcelainV2(res.stdout);

    let entries = status.entries.filter((e) => e.kind !== "ignored");
    const truncated = entries.length > MAX_ENTRIES;
    if (truncated) entries = entries.slice(0, MAX_ENTRIES);

    const tracked = entries.filter((e) => e.kind === "ordinary" || e.kind === "renamed");
    const untracked = entries.filter((e) => e.kind === "untracked");
    const hasRename = entries.some((e) => e.kind === "renamed");

    const [staged, unstaged, untrackedSections, renameCounts, lastCommit, stashes, gitDir, hasRemote] = await Promise.all([
      tracked.some((e) => e.x !== ".") ? streamDiff(cwd, [...PATCH_DIFF_ARGS, "--cached"]) : [],
      tracked.some((e) => e.y !== ".") ? streamDiff(cwd, [...PATCH_DIFF_ARGS]) : [],
      untracked.length ? this.untrackedSections(cwd, untracked) : new Map<string, DiffSection[]>(),
      hasRename ? this.renameCounts(cwd) : new Map<string, { added: number; removed: number }>(),
      this.lastCommit(cwd, status.branch),
      this.stashCount(cwd),
      this.gitDir(cwd),
      this.hasRemote(cwd),
    ]);

    const stagedByPath = groupByPath(staged);
    const unstagedByPath = groupByPath(unstaged);
    const files: ChangedFile[] = [];

    for (const entry of entries) {
      const file: ChangedFile = {
        path: toDisplay(entry.path),
        x: entry.x,
        y: entry.y,
        untracked: entry.kind === "untracked",
        conflict: entry.kind === "unmerged",
        staged: null,
        unstaged: null,
      };
      if (entry.origPath !== undefined) file.oldPath = toDisplay(entry.origPath);

      if (entry.kind === "untracked") {
        file.unstaged = toSide(this.describeUntracked(entry, untrackedSections));
      } else if (entry.kind === "ordinary" || entry.kind === "renamed") {
        if (entry.x !== ".") {
          file.staged = toSide(isRenameLetter(entry.x)
            ? wholeSide("rename", renameCounts.get(entry.path)?.added, renameCounts.get(entry.path)?.removed)
            : describeSide(stagedByPath.get(entry.path), entry, entry.x));
        }
        if (entry.y !== ".") {
          file.unstaged = toSide(isRenameLetter(entry.y)
            ? wholeSide("rename")
            : describeSide(unstagedByPath.get(entry.path), entry, entry.y));
        }
      }
      files.push(file);
    }

    return {
      branch: {
        head: status.branch.head,
        oid: status.branch.oid,
        upstream: status.branch.upstream,
        upstreamGone: !!status.branch.upstream && !status.branch.compared,
        ahead: status.branch.ahead,
        behind: status.branch.behind,
        hasRemote,
      },
      operation: gitDir ? readGitOperation(gitDir) : null,
      files,
      stashes,
      lastCommit,
      truncated,
    };
  }

  private describeUntracked(entry: PorcelainEntry, sections: Map<string, DiffSection[]>): DescribedSide {
    // An untracked directory is a nested repository git will not look into.
    if (entry.path.endsWith("/")) return wholeSide("unread");
    const found = sections.get(entry.path);
    if (!found) return wholeSide("unread");
    return describeSide(found, entry, "A");
  }

  /**
   * Untracked files diffed through a throwaway index holding an intent-to-add
   * entry for each — never the user's index (see `git-hunks`'s
   * `scratchIndexFor`). Large files and anything past the cap are not read.
   */
  private async untrackedSections(cwd: string, entries: PorcelainEntry[]): Promise<Map<string, DiffSection[]>> {
    const files = entries.filter((e) => !e.path.endsWith("/")).slice(0, MAX_UNTRACKED_DIFFED);
    const sizes = await Promise.all(files.map(async (e) => {
      try {
        const st = await lstat(join(cwd, toDisplay(e.path)));
        return st.isSymbolicLink() || (st.isFile() && st.size <= MAX_UNTRACKED_BYTES);
      } catch {
        return false;
      }
    }));
    const readable = files.filter((_, i) => sizes[i]).map((e) => e.path);
    if (readable.length === 0) return new Map();

    const dir = await mkdtemp(join(tmpdir(), "ppm-changes-index-"));
    try {
      const env = { GIT_INDEX_FILE: join(dir, "index") };
      const added = await runGit(cwd, ["add", "-N", "--pathspec-from-file=-", "--pathspec-file-nul"], {
        stdin: Buffer.from(readable.join("\0"), "latin1"),
        env: { ...env, ...LITERAL_PATHSPECS },
      });
      // Listed whole rather than failing the whole tree over one unreadable file.
      if (added.exitCode !== 0) return new Map();
      return groupByPath(await streamDiff(cwd, [...PATCH_DIFF_ARGS], env));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async renameCounts(cwd: string): Promise<Map<string, { added: number; removed: number }>> {
    const res = await runGit(
      cwd,
      ["diff", "--cached", "-M", "--numstat", "-z", "--no-textconv", "--no-ext-diff"],
      { env: BACKGROUND_ENV },
    );
    return res.exitCode === 0 ? parseRenameNumstat(res.stdout) : new Map();
  }

  private async lastCommit(cwd: string, branch: PorcelainBranch): Promise<LastCommit | null> {
    if (!branch.oid) return null;
    const res = await runGit(cwd, ["log", "-1", "--format=%H%x00%P%x00%an%x00%aI%x00%s"], { env: BACKGROUND_ENV });
    if (res.exitCode !== 0) return null;
    const [hash = "", parents = "", author = "", date = "", subject = ""] = res.stdout.replace(/\n$/, "").split("\0");

    // Level with or behind the upstream means HEAD is on it. Without a
    // comparison — no upstream, or one deleted from the remote — ask whether
    // any remote-tracking branch has it.
    let pushed: boolean;
    if (branch.upstream && branch.compared) {
      pushed = branch.ahead === 0;
    } else {
      const refs = await runGit(
        cwd,
        ["for-each-ref", "--count=1", "--contains", hash, "--format=%(refname)", "refs/remotes"],
        { env: BACKGROUND_ENV },
      );
      pushed = refs.exitCode === 0 && refs.stdout.trim() !== "";
    }

    return {
      hash,
      subject: toDisplay(subject),
      author: toDisplay(author),
      date,
      pushed,
      hasParent: parents.trim() !== "",
    };
  }

  private async stashCount(cwd: string): Promise<number> {
    const res = await runGit(cwd, ["rev-list", "--walk-reflogs", "--count", "refs/stash"], { env: BACKGROUND_ENV });
    if (res.exitCode !== 0) return 0;
    const n = Number.parseInt(res.stdout.trim(), 10);
    return Number.isFinite(n) ? n : 0;
  }

  private async hasRemote(cwd: string): Promise<boolean> {
    const res = await runGit(cwd, ["remote"], { env: BACKGROUND_ENV });
    return res.exitCode === 0 && res.stdout.trim() !== "";
  }

  private async gitDir(cwd: string): Promise<string | null> {
    const res = await runGit(cwd, ["rev-parse", "--absolute-git-dir"], { env: BACKGROUND_ENV });
    return res.exitCode === 0 ? toDisplay(res.stdout.trim()) : null;
  }

  /** One file, both sides, with lines. */
  async getFileChanges(cwd: string, path: string, oldPath?: string): Promise<FileChangeDetail> {
    assertSafeFilePath(path);
    if (oldPath) assertSafeFilePath(oldPath);

    const args = ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--", path];
    if (oldPath) args.push(oldPath);
    const res = await runGit(cwd, args, { env: { ...BACKGROUND_ENV, ...LITERAL_PATHSPECS } });
    if (res.exitCode !== 0) throw new Error(res.stderr.trim() || `git status exited with ${res.exitCode}`);
    const entry = parsePorcelainV2(res.stdout).entries.find((e) => toDisplay(e.path) === path);

    const detail: FileChangeDetail = {
      path,
      x: entry?.x ?? ".",
      y: entry?.y ?? ".",
      untracked: entry?.kind === "untracked",
      conflict: entry?.kind === "unmerged",
      staged: null,
      unstaged: null,
    };
    if (!entry || entry.kind === "unmerged" || entry.kind === "ignored") return detail;
    if (entry.origPath !== undefined) detail.oldPath = toDisplay(entry.origPath);

    if (entry.kind === "untracked") {
      detail.unstaged = toSideDetail(await this.untrackedFile(cwd, entry));
      return detail;
    }

    const [staged, unstaged] = await Promise.all([
      entry.x === "."
        ? null
        : isRenameLetter(entry.x) && detail.oldPath
          ? this.renameDetail(cwd, detail.oldPath, path)
          : streamDiff(cwd, [...PATCH_DIFF_ARGS, "--cached", "--", path])
            .then((sections) => describeSide(groupByPath(sections).get(entry.path), entry, entry.x)),
      entry.y === "."
        ? null
        : isRenameLetter(entry.y)
          ? wholeSide("rename")
          : streamDiff(cwd, [...PATCH_DIFF_ARGS, "--", path])
            .then((sections) => describeSide(groupByPath(sections).get(entry.path), entry, entry.y)),
    ]);
    if (staged) detail.staged = toSideDetail(staged);
    if (unstaged) detail.unstaged = toSideDetail(unstaged);
    return detail;
  }

  private async untrackedFile(cwd: string, entry: PorcelainEntry): Promise<DescribedSide> {
    if (entry.path.endsWith("/")) return wholeSide("unread");
    try {
      const st = await lstat(join(cwd, toDisplay(entry.path)));
      if (!st.isSymbolicLink() && !(st.isFile() && st.size <= MAX_UNTRACKED_BYTES)) return wholeSide("large");
    } catch {
      return wholeSide("unread");
    }
    const dir = await mkdtemp(join(tmpdir(), "ppm-changes-index-"));
    try {
      const env = { GIT_INDEX_FILE: join(dir, "index") };
      const display = toDisplay(entry.path);
      const added = await runGit(cwd, ["add", "-N", "--", display], { env: { ...env, ...LITERAL_PATHSPECS } });
      if (added.exitCode !== 0) throw new Error(added.stderr.trim() || `git could not read "${display}".`);
      const sections = await streamDiff(cwd, [...PATCH_DIFF_ARGS, "--", display], env);
      return describeSide(groupByPath(sections).get(entry.path), entry, "A");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * A staged rename shown as git would show it, with rename detection on —
   * for reading only. The hunk routes refuse renames, so the side stays whole.
   */
  private async renameDetail(cwd: string, oldPath: string, path: string): Promise<DescribedSide> {
    const res = await runGit(cwd, [
      "diff", "--cached", "-M", "--no-color", "--no-ext-diff", "--no-textconv",
      "--src-prefix=a/", "--dst-prefix=b/", "--", oldPath, path,
    ], { env: { ...BACKGROUND_ENV, ...LITERAL_PATHSPECS } });
    if (res.exitCode !== 0 || res.stdout.length > MAX_SECTION_BYTES) return wholeSide("rename");
    const parsed = parseUnifiedDiff(res.stdout);
    const added = parsed.hunks.reduce((n, h) => n + countKind(h, "+"), 0);
    const removed = parsed.hunks.reduce((n, h) => n + countKind(h, "-"), 0);
    return { whole: "rename", hunks: parsed.binary ? [] : parsed.hunks, added, removed };
  }
}

function isRenameLetter(letter: string): boolean {
  return letter === "R" || letter === "C";
}

export const gitChangesService = new GitChangesService();
