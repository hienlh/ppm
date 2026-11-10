/**
 * The manager rules file on disk: `<project>/.ppm/manager.md`, and `.ppm/.gitignore` beside it.
 *
 * The file is read only when it is a plain file of its own — not a symlink, not one name of a
 * hardlinked file, inside a real `.ppm` directory — because text that something else writes is
 * not the manager's or the user's. Writes are atomic (temp file + rename), retried on Windows,
 * where a virus scanner or an editor briefly holding the file answers EPERM or EBUSY.
 */
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { RULES_FILE_MAX_BYTES } from "../../shared/assistant-limits.ts";

export const RULES_DIR = ".ppm";
export const RULES_FILE = "manager.md";
/** What `.ppm/.gitignore` must list: PPM's own files, never `*` (`.ppm/` is also a skill root). */
export const RULES_GITIGNORE_LINES = ["/manager.md", "/.gitignore"] as const;
/** A file this large is not even read into memory; it is held as too large. */
const READ_CAP_BYTES = 256 * 1024;
const RENAME_RETRY_MS = [25, 50, 100, 200, 400];
const TRACKED_CHECK_TIMEOUT_MS = 5_000;

export type RulesFileUnsafe = "symlink" | "hardlink" | "not_a_file" | "dir_unsafe";

export type RulesFileRead =
  | { kind: "missing" }
  | { kind: "file"; text: string }
  | { kind: "too_large"; bytes: number; text: string | null }
  /** `replaceable`: an atomic write puts a plain file in its place without touching what it pointed at. */
  | { kind: "unsafe"; reason: RulesFileUnsafe; replaceable: boolean };

export const rulesFilePath = (projectPath: string) => join(projectPath, RULES_DIR, RULES_FILE);

const code = (e: unknown) => (e as NodeJS.ErrnoException)?.code;

async function lstatOrNull(path: string) {
  try {
    return await lstat(path);
  } catch (e) {
    if (code(e) === "ENOENT" || code(e) === "ENOTDIR") return null;
    throw e;
  }
}

export async function readRulesFile(projectPath: string): Promise<RulesFileRead> {
  const dir = await lstatOrNull(join(projectPath, RULES_DIR));
  if (!dir) return { kind: "missing" };
  if (dir.isSymbolicLink() || !dir.isDirectory()) return { kind: "unsafe", reason: "dir_unsafe", replaceable: false };
  const path = rulesFilePath(projectPath);
  const st = await lstatOrNull(path);
  if (!st) return { kind: "missing" };
  if (st.isSymbolicLink()) return { kind: "unsafe", reason: "symlink", replaceable: true };
  if (!st.isFile()) return { kind: "unsafe", reason: "not_a_file", replaceable: false };
  if (st.nlink > 1) return { kind: "unsafe", reason: "hardlink", replaceable: true };
  if (st.size > RULES_FILE_MAX_BYTES) {
    return { kind: "too_large", bytes: st.size, text: st.size <= READ_CAP_BYTES ? await readFile(path, "utf8") : null };
  }
  const text = await readFile(path, "utf8");
  // Written between the lstat and the read: judged by what was read.
  if (Buffer.byteLength(text) > RULES_FILE_MAX_BYTES) return { kind: "too_large", bytes: Buffer.byteLength(text), text };
  return { kind: "file", text };
}

/** `.ppm` itself, created when missing (never the project folder) and refused when it is not a real directory. */
async function ensureRulesDir(projectPath: string): Promise<string> {
  const dir = join(projectPath, RULES_DIR);
  try {
    await mkdir(dir);
  } catch (e) {
    if (code(e) !== "EEXIST") throw e;
  }
  const st = await lstat(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${RULES_DIR} in ${projectPath} is not a folder PPM can write to`);
  return dir;
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (e) {
      const transient = code(e) === "EPERM" || code(e) === "EBUSY" || code(e) === "EACCES";
      if (!transient || attempt >= RENAME_RETRY_MS.length) throw e;
      await new Promise((r) => setTimeout(r, RENAME_RETRY_MS[attempt]));
    }
  }
}

/** Replaces `target` (a link included: the link goes, what it pointed at stays) with `text`. */
async function atomicWrite(target: string, text: string): Promise<void> {
  const tmp = join(dirname(target), `.${basename(target)}.${randomUUID().slice(0, 8)}.tmp`);
  await writeFile(tmp, text, { flag: "wx" });
  try {
    await renameWithRetry(tmp, target);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

/** Appends the lines `.ppm/.gitignore` is missing; leaves a link or a non-file alone. */
export async function ensureRulesGitignore(projectPath: string): Promise<void> {
  const dir = await ensureRulesDir(projectPath);
  const path = join(dir, ".gitignore");
  const st = await lstatOrNull(path);
  if (st && (st.isSymbolicLink() || !st.isFile())) return;
  const current = st ? await readFile(path, "utf8") : "";
  const have = new Set(current.split(/\r?\n/).map((l) => l.trim()));
  const missing = RULES_GITIGNORE_LINES.filter((line) => !have.has(line));
  if (missing.length === 0) return;
  const sep = current === "" || current.endsWith("\n") ? "" : "\n";
  await atomicWrite(path, `${current}${sep}${missing.join("\n")}\n`);
}

/** Writes the rules file and keeps `.ppm/.gitignore` listing it. */
export async function writeRulesFile(projectPath: string, text: string): Promise<void> {
  const dir = await ensureRulesDir(projectPath);
  await atomicWrite(join(dir, RULES_FILE), text);
  await ensureRulesGitignore(projectPath);
}

/**
 * Whether git tracks `.ppm/manager.md`: a file a repository ships, or one `git pull` can rewrite,
 * is not text the manager or the user wrote. No git, or no repository, means untracked; a check
 * that does not finish is `unknown`, which callers treat like tracked.
 */
export async function rulesFileTracked(projectPath: string, timeoutMs = TRACKED_CHECK_TIMEOUT_MS): Promise<"tracked" | "untracked" | "unknown"> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["git", "ls-files", "--error-unmatch", "--", `${RULES_DIR}/${RULES_FILE}`], {
      cwd: projectPath, stdout: "ignore", stderr: "ignore", stdin: "ignore",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
  } catch {
    return "untracked";
  }
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill(); }, timeoutMs);
  try {
    const exit = await proc.exited;
    if (timedOut) return "unknown";
    return exit === 0 ? "tracked" : "untracked";
  } finally {
    clearTimeout(timer);
  }
}
