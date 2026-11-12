/**
 * The file as git's index holds it, for the editor's change bars
 * (`GET /git/index-base`, shape in `src/shared/git-index-base.ts`).
 *
 * Two git calls, and on most asks only the first:
 * - `git ls-files --stage` names the blob the index holds for the path. When
 *   it is the one the browser already has (`known`), that is the whole answer.
 * - `git cat-file --filters` reads that blob *as checkout would write it*:
 *   smudge filters and end-of-line conversion applied. Without them a file
 *   under `core.autocrlf` or Git LFS differs from its own index on every line,
 *   and the gutter would mark the whole file. Reading by blob id rather than by
 *   `:path` means the content is exactly the blob whose id is returned, however
 *   the index moves between the two calls.
 *
 * Both run with `GIT_OPTIONAL_LOCKS=0` (this is polled; it must never be the
 * reason a user's own `git commit` finds `index.lock`) and literal pathspecs,
 * so a file named `*.ts` is that file and not every TypeScript file.
 *
 * Paths are relative to the directory git runs in, as the blame route's are:
 * the repository, or the project folder when the project sits inside one.
 */
import { spawn } from "node:child_process";
import { posix } from "node:path";
import { isBinaryContent } from "../binary-content.ts";
import { LITERAL_PATHSPECS, assertSafeFilePath, runGit } from "../git-hunks/git-hunks.service.ts";
import { INDEX_BASE_MAX_BYTES, type IndexBase } from "../../shared/git-index-base.ts";

const ENV = { ...LITERAL_PATHSPECS, GIT_OPTIONAL_LOCKS: "0" };

/** A regular file, executable or not. Symlinks (120000) and submodules (160000) are not text the editor shows. */
const FILE_MODES = new Set(["100644", "100755"]);

/** The path as `ls-files` prints it: forward slashes, no `./`, no `a/../`. */
function normalize(path: string): string {
  return posix.normalize(path.replace(/\\/g, "/")).replace(/^\.\//, "");
}

interface IndexEntry {
  mode: string;
  oid: string;
  stage: string;
}

/** The index entries for exactly `path` — `ls-files` also lists a directory's contents. */
async function indexEntries(cwd: string, path: string): Promise<IndexEntry[]> {
  const result = await runGit(cwd, ["ls-files", "-z", "--stage", "--", path], { env: ENV });
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "git ls-files failed");
  const want = normalize(path);
  const entries: IndexEntry[] = [];
  for (const record of result.stdout.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    // `runGit` decodes as latin1, so the path is compared in those terms too.
    const name = Buffer.from(record.slice(tab + 1), "latin1").toString("utf8");
    if (name !== want) continue;
    const [mode = "", oid = "", stage = ""] = record.slice(0, tab).split(" ");
    entries.push({ mode, oid, stage });
  }
  return entries;
}

/**
 * The blob's bytes as checkout writes them, or `null` past `max`. The child is
 * killed at the cap, so a large file (an LFS object is smudged to its full
 * size) is never held whole just to be refused.
 */
function readBlob(cwd: string, args: string[], max: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...ENV } });
    const chunks: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let over = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (over) return;
      size += chunk.length;
      if (size > max) {
        over = true;
        child.kill();
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr.push(chunk); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (over) resolve(null);
      else if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `git ${args[0]} exited with ${code}`));
    });
    child.stdin.end();
  });
}

class GitIndexBaseService {
  async read(cwd: string, filePath: string, known?: string, max = INDEX_BASE_MAX_BYTES): Promise<IndexBase> {
    const path = assertSafeFilePath(filePath);
    const entries = await indexEntries(cwd, path);
    if (entries.length === 0) return { state: "none", reason: "untracked" };
    if (entries.length > 1 || entries[0]!.stage !== "0") return { state: "none", reason: "conflict" };
    const { mode, oid } = entries[0]!;
    if (!FILE_MODES.has(mode)) return { state: "none", reason: "not-a-file" };
    if (known && known === oid) return { state: "same", oid };

    let bytes: Buffer | null;
    try {
      bytes = await readBlob(cwd, ["cat-file", "--filters", `--path=${normalize(path)}`, oid], max);
    } catch {
      // A filter that cannot run here (Git LFS not installed, a custom driver
      // missing) still leaves the blob itself, which is what the file was
      // before the filter — as close as this host can get.
      bytes = await readBlob(cwd, ["cat-file", "blob", oid], max);
    }
    if (bytes === null) return { state: "none", reason: "too-large", oid };
    if (isBinaryContent(bytes)) return { state: "none", reason: "binary", oid };
    return { state: "ok", oid, content: bytes.toString("utf8") };
  }
}

export const gitIndexBaseService = new GitIndexBaseService();
