import { Hono } from "hono";
import { resolve, sep } from "node:path";
import { gitService } from "../../services/git.service.ts";
import { gitHunksService, type HunkRequest, type HunkScope } from "../../services/git-hunks/git-hunks.service.ts";
import { gitBlameService } from "../../services/git-blame/git-blame.service.ts";
import { branchDiff } from "../../services/git-branch-diff/branch-diff.service.ts";
import { discoverGitRepos, isGitRepo } from "../../services/git-repos/git-repo-discovery.ts";
import { ok, err } from "../../types/api.ts";

type Env = { Variables: { projectPath: string; projectName: string } };

export const gitRoutes = new Hono<Env>();

/**
 * `?repo=` scopes every git route below to one repository inside the project.
 *
 * A workspace folder is often a container whose *children* are the
 * repositories, so the project path and the git root are not the same
 * directory. Rather than teach each of the twenty-odd handlers, the parameter
 * is resolved once here and `projectPath` is replaced — every handler already
 * reads that, and `git.service` already takes the directory to run in.
 *
 * It is validated, and a bad value is a 400 rather than a fallback to the
 * project root. Falling back would run the command one directory up and answer
 * with *a* history — the wrong one — which is indistinguishable from a working
 * feature until someone acts on it.
 */
gitRoutes.use("*", async (c, next) => {
  const repo = c.req.query("repo");
  if (repo) {
    const root = resolve(c.get("projectPath"));
    const target = resolve(repo);
    if (target !== root && !target.startsWith(root + sep)) {
      return c.json(err("repo is outside the project"), 400);
    }
    if (!isGitRepo(target)) {
      return c.json(err("repo is not a git repository"), 400);
    }
    c.set("projectPath", target);
  }
  await next();
});

/**
 * GET /git/repos — the repositories under this project.
 *
 * Answers for a project whose root is not a repository, which is the case the
 * git surfaces used to report as an error.
 */
gitRoutes.get("/repos", (c) => {
  try {
    return c.json(ok(discoverGitRepos(c.get("projectPath"))));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** GET /git/status */
gitRoutes.get("/status", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const status = await gitService.status(projectPath);
    return c.json(ok(status));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** GET /git/diff?ref1=&ref2= */
gitRoutes.get("/diff", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const ref1 = c.req.query("ref1") || undefined;
    const ref2 = c.req.query("ref2") || undefined;
    const diff = await gitService.diff(projectPath, ref1, ref2);
    return c.json(ok({ diff }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** GET /git/diff-stat?ref1=&ref2= — file list with +/- counts */
gitRoutes.get("/diff-stat", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const ref1 = c.req.query("ref1") || undefined;
    const ref2 = c.req.query("ref2") || undefined;
    const files = await gitService.diffStat(projectPath, ref1, ref2);
    return c.json(ok(files));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/**
 * GET /git/branch-diff?base=&head=&mode=three-dot|two-dot
 *
 * Every file a branch changed, in one answer, plus the commit those changes
 * were measured against. The Branch Review tab opens each file's diff at
 * `mergeBase`, so the list and the viewer can never disagree about the base.
 *
 * A bad ref is a 400, not a 500: `base` and `head` come straight from a picker,
 * and a branch deleted since it was rendered is an ordinary thing to ask about.
 */
gitRoutes.get("/branch-diff", async (c) => {
  const projectPath = c.get("projectPath");
  const mode = c.req.query("mode") === "two-dot" ? "two-dot" : "three-dot";
  try {
    const result = await branchDiff(
      projectPath,
      c.req.query("base"),
      c.req.query("head"),
      mode,
    );
    return c.json(ok(result));
  } catch (e) {
    return c.json(err((e as Error).message), 400);
  }
});

/** GET /git/file-diff?file=&ref= */
gitRoutes.get("/file-diff", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const file = c.req.query("file");
    if (!file) return c.json(err("Missing query: file"), 400);
    const ref = c.req.query("ref") || undefined;
    const diff = await gitService.fileDiff(projectPath, file, ref);
    return c.json(ok({ diff }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** GET /git/file-full-diff?file=&ref=&ref2=&text=1
 *  Returns full file contents (VSCode-style) for both sides:
 *  { original: <ref version>, modified: <working tree> }
 *  A binary file answers `binary: true` with both sides empty; `text=1` is the
 *  viewer's "Open Anyway" and asks for the decoded bytes regardless. */
gitRoutes.get("/file-full-diff", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const file = c.req.query("file");
    if (!file) return c.json(err("Missing query: file"), 400);
    const ref = c.req.query("ref") || "HEAD";
    const ref2 = c.req.query("ref2") || undefined;
    const result = await gitService.fileFullDiff(projectPath, file, ref, ref2, {
      text: c.req.query("text") === "1",
    });
    return c.json(ok(result));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/**
 * The content types `/git/file-blob` will name. Everything outside this list is
 * served as `application/octet-stream`: a blob URL inherits *this* origin, so
 * answering with the repository's own `text/html` — or `image/svg+xml`, which
 * carries script — would let a committed file run code inside the app.
 */
const BLOB_IMAGE_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", bmp: "image/bmp", ico: "image/x-icon", avif: "image/avif",
};

/**
 * GET /git/file-blob?file=&ref=HEAD — the file's bytes at a revision.
 *
 * What the binary diff view draws its left-hand pane from: `/files/raw` serves
 * the working tree, and nothing else reaches the version a commit holds. The
 * path needs no traversal check of its own — git resolves `ref:path` inside the
 * repository and refuses anything above it ("is outside repository").
 */
gitRoutes.get("/file-blob", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const file = c.req.query("file");
    if (!file) return c.json(err("Missing query: file"), 400);
    const ref = c.req.query("ref") || "HEAD";
    const bytes = await gitService.fileBlob(projectPath, file, ref);
    if (!bytes) return c.json(err("File does not exist at that revision"), 404);
    const ext = file.split(".").pop()?.toLowerCase() ?? "";
    // Copied into a plain Uint8Array because a Buffer is typed over
    // ArrayBufferLike, which BodyInit does not accept.
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": BLOB_IMAGE_TYPES[ext] ?? "application/octet-stream",
        "Content-Length": String(bytes.length),
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** GET /git/graph?max=200&skip=0 */
gitRoutes.get("/graph", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const max = parseInt(c.req.query("max") ?? "200", 10);
    const skip = parseInt(c.req.query("skip") ?? "0", 10);
    const data = await gitService.graphData(projectPath, max, skip);
    return c.json(ok(data));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** GET /git/branches */
gitRoutes.get("/branches", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const branches = await gitService.branches(projectPath);
    return c.json(ok(branches));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** GET /git/pr-url?branch= */
gitRoutes.get("/pr-url", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const branch = c.req.query("branch");
    if (!branch) return c.json(err("Missing query: branch"), 400);
    const url = await gitService.getCreatePrUrl(projectPath, branch);
    return c.json(ok({ url }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /git/fetch { remote? } */
gitRoutes.post("/fetch", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const body = await c.req.json<{ remote?: string }>().catch(() => ({ remote: undefined }));
    const { remote } = body;
    await gitService.fetch(projectPath, remote);
    return c.json(ok({ fetched: true }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /git/discard { files } — discard unstaged changes (checkout tracked, clean untracked) */
gitRoutes.post("/discard", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const { files } = await c.req.json<{ files: string[] }>();
    if (!files?.length) return c.json(err("Missing: files"), 400);
    await gitService.discardChanges(projectPath, files);
    return c.json(ok({ discarded: files }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /git/stage { files } */
gitRoutes.post("/stage", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const { files } = await c.req.json<{ files: string[] }>();
    if (!files?.length) return c.json(err("Missing: files"), 400);
    await gitService.stage(projectPath, files);
    return c.json(ok({ staged: files }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /git/unstage { files } */
gitRoutes.post("/unstage", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const { files } = await c.req.json<{ files: string[] }>();
    if (!files?.length) return c.json(err("Missing: files"), 400);
    await gitService.unstage(projectPath, files);
    return c.json(ok({ unstaged: files }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/**
 * GET /git/blame?path=&rev= — the whole file's blame, for the editor annotation.
 *
 * `rev` blames the file as it stood at that revision, which is what each side of
 * the diff viewer needs; omitted, it blames the working tree.
 */
gitRoutes.get("/blame", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const filePath = c.req.query("path");
    if (!filePath) return c.json(err("Missing: path"), 400);
    const rev = c.req.query("rev") || undefined;
    const result = await gitBlameService.blameFile(projectPath, filePath, rev);
    // Untracked, or absent at that revision — not an error the UI should show.
    return c.json(ok(result ?? { lines: [], commits: {} }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/**
 * GET /git/commit-line?hash=&path=&line= — the commit message and the one-line
 * diff behind a blamed line, for the editor's hover.
 *
 * `path` and `line` are the path and line number *at that commit*, which is
 * what `git blame --porcelain` reports; the browser passes them straight back
 * from the blame it already has.
 */
gitRoutes.get("/commit-line", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const hash = c.req.query("hash");
    const filePath = c.req.query("path");
    const line = Number(c.req.query("line"));
    if (!hash) return c.json(err("Missing: hash"), 400);
    if (!filePath) return c.json(err("Missing: path"), 400);
    if (!Number.isInteger(line) || line < 1) return c.json(err("Invalid: line"), 400);
    const result = await gitBlameService.lineDetail(projectPath, hash, filePath, line);
    // An unknown hash or a path git never had is "no hover", not an error.
    return c.json(ok(result));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** GET /git/hunks?path=&scope=worktree|index — the hunks the UI selects from */
gitRoutes.get("/hunks", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const filePath = c.req.query("path");
    if (!filePath) return c.json(err("Missing: path"), 400);
    const scope = c.req.query("scope") === "index" ? "index" : "worktree";
    const result = await gitHunksService.getHunks(projectPath, filePath, scope as HunkScope);
    return c.json(ok(result));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/**
 * Hunk-level staging. `hunks` carries indexes into the list `GET /git/hunks`
 * returned; a hunk without `lines` is taken whole. Indexes are resolved against
 * a freshly read diff, so an edit in between makes `git apply` fail rather than
 * stage the wrong lines.
 */
function readHunkBody(body: { path?: string; hunks?: HunkRequest[] }): { filePath: string; hunks: HunkRequest[] } | string {
  if (!body.path) return "Missing: path";
  if (!Array.isArray(body.hunks) || body.hunks.length === 0) return "Missing: hunks";
  return { filePath: body.path, hunks: body.hunks };
}

/** POST /git/stage-hunks { path, hunks: [{ hunk, lines? }] } */
gitRoutes.post("/stage-hunks", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const parsed = readHunkBody(await c.req.json());
    if (typeof parsed === "string") return c.json(err(parsed), 400);
    await gitHunksService.stage(projectPath, parsed.filePath, parsed.hunks);
    return c.json(ok({ staged: parsed.filePath }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /git/unstage-hunks { path, hunks: [{ hunk, lines? }] } */
gitRoutes.post("/unstage-hunks", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const parsed = readHunkBody(await c.req.json());
    if (typeof parsed === "string") return c.json(err(parsed), 400);
    await gitHunksService.unstage(projectPath, parsed.filePath, parsed.hunks);
    return c.json(ok({ unstaged: parsed.filePath }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /git/discard-hunks { path, hunks: [{ hunk, lines? }] } — not recoverable */
gitRoutes.post("/discard-hunks", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const parsed = readHunkBody(await c.req.json());
    if (typeof parsed === "string") return c.json(err(parsed), 400);
    await gitHunksService.discard(projectPath, parsed.filePath, parsed.hunks);
    return c.json(ok({ discarded: parsed.filePath }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /git/commit { message, amend? } */
gitRoutes.post("/commit", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const { message, amend } = await c.req.json<{ message?: string; amend?: boolean }>();
    if (!amend && !message) return c.json(err("Missing: message"), 400);
    const hash = await gitService.commit(projectPath, message ?? "", !!amend);
    return c.json(ok({ hash }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /git/push { remote?, branch? } */
gitRoutes.post("/push", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const { remote, branch } = await c.req.json<{ remote?: string; branch?: string }>();
    await gitService.push(projectPath, remote, branch);
    return c.json(ok({ pushed: true }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /git/pull { remote?, branch? } */
gitRoutes.post("/pull", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const { remote, branch } = await c.req.json<{ remote?: string; branch?: string }>();
    await gitService.pull(projectPath, remote, branch);
    return c.json(ok({ pulled: true }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /git/branch/create { name, from? } */
gitRoutes.post("/branch/create", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const { name, from } = await c.req.json<{ name: string; from?: string }>();
    if (!name) return c.json(err("Missing: name"), 400);
    await gitService.createBranch(projectPath, name, from);
    return c.json(ok({ created: name }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /git/checkout { ref } */
gitRoutes.post("/checkout", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const { ref } = await c.req.json<{ ref: string }>();
    if (!ref) return c.json(err("Missing: ref"), 400);
    await gitService.checkout(projectPath, ref);
    return c.json(ok({ checkedOut: ref }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /git/branch/delete { name, force? } */
gitRoutes.post("/branch/delete", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const { name, force } = await c.req.json<{ name: string; force?: boolean }>();
    if (!name) return c.json(err("Missing: name"), 400);
    await gitService.deleteBranch(projectPath, name, force);
    return c.json(ok({ deleted: name }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /git/merge { source } */
gitRoutes.post("/merge", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const { source } = await c.req.json<{ source: string }>();
    if (!source) return c.json(err("Missing: source"), 400);
    await gitService.merge(projectPath, source);
    return c.json(ok({ merged: source }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /git/cherry-pick { hash } */
gitRoutes.post("/cherry-pick", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const { hash } = await c.req.json<{ hash: string }>();
    if (!hash) return c.json(err("Missing: hash"), 400);
    await gitService.cherryPick(projectPath, hash);
    return c.json(ok({ cherryPicked: hash }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /git/revert { hash } */
gitRoutes.post("/revert", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const { hash } = await c.req.json<{ hash: string }>();
    if (!hash) return c.json(err("Missing: hash"), 400);
    await gitService.revert(projectPath, hash);
    return c.json(ok({ reverted: hash }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /git/tag { name, hash? } */
gitRoutes.post("/tag", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const { name, hash } = await c.req.json<{ name: string; hash?: string }>();
    if (!name) return c.json(err("Missing: name"), 400);
    await gitService.createTag(projectPath, name, hash);
    return c.json(ok({ tagged: name }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

// ---------------------------------------------------------------------------
// Worktree routes
// ---------------------------------------------------------------------------

/** GET /git/worktrees */
gitRoutes.get("/worktrees", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const worktrees = await gitService.listWorktrees(projectPath);
    return c.json(ok(worktrees));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /git/worktree/add { path, branch?, newBranch? } */
gitRoutes.post("/worktree/add", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const { path: targetPath, branch, newBranch } = await c.req.json<{
      path: string;
      branch?: string;
      newBranch?: string;
    }>();
    if (!targetPath) return c.json(err("Missing: path"), 400);
    await gitService.addWorktree(projectPath, targetPath, { branch, newBranch });
    return c.json(ok({ added: targetPath }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /git/worktree/remove { path, force? } */
gitRoutes.post("/worktree/remove", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const { path: targetPath, force } = await c.req.json<{ path: string; force?: boolean }>();
    if (!targetPath) return c.json(err("Missing: path"), 400);
    await gitService.removeWorktree(projectPath, targetPath, force);
    return c.json(ok({ removed: targetPath }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /git/worktree/prune */
gitRoutes.post("/worktree/prune", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    await gitService.pruneWorktrees(projectPath);
    return c.json(ok({ pruned: true }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});
