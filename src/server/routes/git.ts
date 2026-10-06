import { Hono } from "hono";
import { resolve } from "node:path";
import { gitService, remoteForLog } from "../../services/git.service.ts";
import { gitHunksService, type HunkRequest, type HunkScope } from "../../services/git-hunks/git-hunks.service.ts";
import { assertSafeRev, gitBlameService } from "../../services/git-blame/git-blame.service.ts";
import { branchDiff } from "../../services/git-branch-diff/branch-diff.service.ts";
import { assertRef } from "../../services/git-branch-diff/branch-diff-parse.ts";
import { discoverGitRepos, isGitRepo } from "../../services/git-repos/git-repo-discovery.ts";
import { gitChangesService } from "../../services/git-changes/git-changes.service.ts";
import { gitDiscardJournal } from "../../services/git-discard-journal/git-discard-journal.service.ts";
import { gitCommitDraftService } from "../../services/git-commit-draft.service.ts";
import { gitWorkflowService } from "../../services/git-workflow/git-workflow.service.ts";
import { emitGitEvent } from "../../services/git-changes/git-events.ts";
import { isInsideDir, realPathOrSelfSync } from "../../services/fs-ops/fs-real-path.ts";
import { createLogger } from "../../services/logger.ts";
import { ok, err } from "../../types/api.ts";
import type { CheckoutMode } from "../../types/git.ts";

/**
 * Commit, push, branch create/checkout/delete and merge are logged here rather than in
 * `git.service`, because the CLI calls those service methods as well and has no log file — a
 * line there would print in the terminal beside the CLI's own message. The rest of the git
 * writes are logged by their services.
 */
const log = createLogger("git");

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
 *
 * Both sides go through `realPathOrSelfSync` first. `resolve` is purely
 * textual, so a symlink inside the project pointing anywhere on the host
 * resolves to an in-project path, passes, and git runs in the link's target.
 * Discovery refuses to *offer* such a path, but this parameter comes straight
 * from the client and is not obliged to be one discovery returned.
 *
 * Containment is `isInsideDir`, which folds case on Windows: `c:\users\pc\ppm`
 * and `C:\Users\PC\ppm` are one directory, and a case-sensitive prefix test
 * answers 400 for the second — a path this server handed out itself.
 */
gitRoutes.use("*", async (c, next) => {
  const repo = c.req.query("repo");
  if (repo) {
    const root = realPathOrSelfSync(resolve(c.get("projectPath")));
    const target = realPathOrSelfSync(resolve(repo));
    if (!isInsideDir(target, root)) {
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
 * Every POST below writes to the repository, so tell every git surface —
 * Source Control, the Review tab, the Git Graph — to read it again now rather
 * than at its next poll. A failed command counts too: a merge that stops on a
 * conflict answers with an error and has changed the tree all the same.
 */
gitRoutes.use("*", async (c, next) => {
  await next();
  if (c.req.method !== "POST") return;
  const repo = c.get("projectPath");
  gitChangesService.invalidate(repo);
  emitGitEvent({ type: "git:changed", projectName: c.get("projectName"), repo });
});

/** The shared commit message changed: every surface showing it updates. */
function broadcastCommitDraft(projectName: string, repo: string, draft: { message: string; updatedAt: string | null }, clientId: string | null): void {
  emitGitEvent({ type: "git:commit-draft", projectName, repo, ...draft, clientId });
}

/**
 * The `ref`-ish query parameters, refused at the boundary rather than handed on.
 *
 * A revision reaches git as its own argv word, so the hazard is not a shell
 * metacharacter but a value that changes what the command *is*: `?ref1=--output=/tmp/x`
 * is an option, not a revision, and `git diff` honours it. `assertSafeRev` is
 * the rule the blame path already states — no leading dash, no `..` range, none
 * of what `check-ref-format` forbids — and `HEAD~1` and `main^` still pass,
 * because those are what the diff viewer actually asks for.
 */
function invalidRev(...revs: Array<string | undefined>): string | null {
  for (const rev of revs) {
    if (rev === undefined) continue;
    try {
      assertSafeRev(rev);
    } catch (e) {
      return (e as Error).message;
    }
  }
  return null;
}

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

/** GET /git/changes — every changed file with its blocks, plus branch and merge state. */
gitRoutes.get("/changes", async (c) => {
  try {
    return c.json(ok(await gitChangesService.getChanges(c.get("projectPath"))));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** GET /git/changes/file?path=&oldPath= — one file's blocks with their lines, both sides. */
gitRoutes.get("/changes/file", async (c) => {
  const path = c.req.query("path");
  if (!path) return c.json(err("Missing: path"), 400);
  try {
    const detail = await gitChangesService.getFileChanges(c.get("projectPath"), path, c.req.query("oldPath") || undefined);
    return c.json(ok(detail));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** GET /git/commit-draft — the message being written for this repository. */
gitRoutes.get("/commit-draft", (c) => {
  try {
    return c.json(ok(gitCommitDraftService.get(c.get("projectPath"))));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/**
 * PUT /git/commit-draft { message, clientId? } — `clientId` comes back in the
 * broadcast so the surface that typed it can ignore its own echo.
 */
gitRoutes.put("/commit-draft", async (c) => {
  const body = await c.req.json<{ message?: unknown; clientId?: unknown }>().catch(() => ({} as { message?: unknown; clientId?: unknown }));
  if (typeof body.message !== "string") return c.json(err("Missing: message"), 400);
  try {
    const repo = c.get("projectPath");
    const draft = gitCommitDraftService.set(repo, body.message);
    broadcastCommitDraft(c.get("projectName"), repo, draft, typeof body.clientId === "string" ? body.clientId : null);
    return c.json(ok(draft));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** GET /git/discards — discards that can still be undone, newest first. */
gitRoutes.get("/discards", async (c) => {
  try {
    return c.json(ok(await gitDiscardJournal.list(c.get("projectPath"))));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /git/discard/undo { id } — 409 when the file changed since and Undo would overwrite that. */
gitRoutes.post("/discard/undo", async (c) => {
  const { id } = await c.req.json<{ id?: unknown }>().catch(() => ({ id: undefined }));
  if (typeof id !== "string" || !id) return c.json(err("Missing: id"), 400);
  try {
    return c.json(ok(await gitDiscardJournal.undo(c.get("projectPath"), id)));
  } catch (e) {
    return c.json(err((e as Error).message), 409);
  }
});

/** GET /git/diff?ref1=&ref2= */
gitRoutes.get("/diff", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const ref1 = c.req.query("ref1") || undefined;
    const ref2 = c.req.query("ref2") || undefined;
    const bad = invalidRev(ref1, ref2);
    if (bad) return c.json(err(bad), 400);
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
    const bad = invalidRev(ref1, ref2);
    if (bad) return c.json(err(bad), 400);
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
    const bad = invalidRev(ref);
    if (bad) return c.json(err(bad), 400);
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
    const bad = invalidRev(ref, ref2);
    if (bad) return c.json(err(bad), 400);
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
    // The same guard as every sibling route, and it is not decoration here: `ref` reaches
    // `git show` as its own argv word, so `?ref=--output=<path>` is an option rather than a
    // revision. Measured on a scratch repository, `git show --output=<victim> HEAD:a.txt`
    // exits 0 and leaves the victim at zero bytes — arbitrary file destruction, on a server
    // that is routinely reachable through a public tunnel URL.
    const bad = invalidRev(ref);
    if (bad) return c.json(err(bad), 400);
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

/**
 * GET /git/refs — every checkout target the branch picker offers.
 *
 * Separate from `/branches` rather than an enrichment of it: this answer costs
 * one `for-each-ref` over *three* namespaces and carries a commit per row,
 * where `/branches` is the cheap list the graph and the review pickers read on
 * mount.
 */
gitRoutes.get("/refs", async (c) => {
  try {
    return c.json(ok(await gitService.refs(c.get("projectPath"))));
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

/** POST /git/fetch { remote?, prune? } — every remote when none is named */
gitRoutes.post("/fetch", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const body = await c.req.json<{ remote?: string; prune?: boolean }>().catch(() => ({ remote: undefined, prune: undefined }));
    const { remote } = body;
    // Its own argv word, so `--prune-tags` here would be a flag: with `prune`, it deletes every
    // tag the remote does not have, and a tag has no reflog to bring it back from.
    if (remote !== undefined && (typeof remote !== "string" || remote.startsWith("-"))) {
      return c.json(err(`Invalid remote: "${String(remote)}"`), 400);
    }
    await gitService.fetch(projectPath, remote, body.prune === true);
    return c.json(ok({ fetched: true }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/**
 * POST /git/discard { files } — discard unstaged changes (checkout tracked, clean untracked).
 * Answers with an `undo` record; a 500 carries one too when the discard failed part way.
 */
gitRoutes.post("/discard", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const { files } = await c.req.json<{ files: string[] }>();
    if (!files?.length) return c.json(err("Missing: files"), 400);
    // The copy comes first: git keeps nothing of what it throws away.
    const pending = await gitDiscardJournal.captureFiles(projectPath, files);
    try {
      await gitService.discardChanges(projectPath, files);
    } catch (e) {
      // It may have got part way (the tracked files go before the untracked
      // ones): the answer carries the Undo for whatever it already threw away.
      const undo = await gitDiscardJournal.failed(pending);
      return c.json({ ...err((e as Error).message), undo }, 500);
    }
    // The discard happened, and the entry written before it can still undo it.
    const undo = await gitDiscardJournal.commitFiles(pending).catch((e) => {
      log.error(`could not note what the discard in ${projectPath} left; its Undo is the entry written before it:`, e);
      return gitDiscardJournal.summarize(pending);
    });
    return c.json(ok({ discarded: files, undo }));
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
 * Hunk-level staging. Each entry carries the `id` that `GET /git/hunks` gave
 * for that hunk; a hunk without `lines` is taken whole.
 *
 * `id` is required, and that is the whole safety property: the service reads
 * the diff again at apply time, so a positional index alone would be resolved
 * against a *different* list than the one the user ticked and would stage
 * whatever now sits at that position. `git apply` cannot catch it either,
 * because the patch is built from the fresh diff and therefore applies. An
 * entry with no `id` is refused rather than trusted.
 */
function readHunkBody(body: { path?: string; hunks?: HunkRequest[] }): { filePath: string; hunks: HunkRequest[] } | string {
  if (!body.path) return "Missing: path";
  if (!Array.isArray(body.hunks) || body.hunks.length === 0) return "Missing: hunks";
  for (const entry of body.hunks) {
    if (!entry || typeof entry.id !== "string" || entry.id.length === 0) {
      return "Each hunk needs the id it was listed with";
    }
  }
  return { filePath: body.path, hunks: body.hunks };
}

/** POST /git/stage-hunks { path, hunks: [{ hunk, id, lines? }] } */
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

/** POST /git/unstage-hunks { path, hunks: [{ hunk, id, lines? }] } */
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

/**
 * POST /git/discard-hunks { path, hunks: [{ hunk, id, lines? }] } — answers with
 * an `undo` record, or `undo: null` if the copy could not be kept.
 */
gitRoutes.post("/discard-hunks", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const parsed = readHunkBody(await c.req.json());
    if (typeof parsed === "string") return c.json(err(parsed), 400);
    const patch = await gitHunksService.discard(projectPath, parsed.filePath, parsed.hunks);
    // The discard already happened; failing to keep a copy must not report it as failed.
    const undo = await gitDiscardJournal.recordHunks(projectPath, parsed.filePath, patch).catch((e) => {
      log.error(`could not keep an undo copy of the discarded hunks of ${parsed.filePath} in ${projectPath} — the discard cannot be undone:`, e);
      return null;
    });
    return c.json(ok({ discarded: parsed.filePath, undo }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/**
 * POST /git/commit { message, amend?, signoff? } — clears the shared commit message,
 * unless it was written again while the commit ran: what was typed during the hooks
 * is the next message. One that still holds what was committed, or that nobody
 * saved to since (a box that committed before its last keystrokes were saved), goes.
 */
gitRoutes.post("/commit", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const { message, amend, signoff } = await c.req.json<{ message?: string; amend?: boolean; signoff?: boolean }>();
    if (!amend && !message) return c.json(err("Missing: message"), 400);
    let draftBefore: string | null = null;
    try { draftBefore = gitCommitDraftService.get(projectPath).message; } catch { /* the commit does not need it */ }
    const hash = await gitService.commit(projectPath, message ?? "", !!amend, !!signoff);
    log.info(`committed ${hash.slice(0, 7)} in ${projectPath} (amend=${!!amend}, signoff=${!!signoff})`);
    try {
      const draft = gitCommitDraftService.get(projectPath).message;
      if (draft === draftBefore || draft.trim() === (message ?? "").trim()) {
        broadcastCommitDraft(c.get("projectName"), projectPath, gitCommitDraftService.set(projectPath, ""), null);
      }
    } catch { /* the commit stands either way */ }
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
    const started = performance.now();
    await gitService.push(projectPath, remote, branch);
    log.info(`pushed ${branch ?? "the current branch"} to ${remote ? remoteForLog(remote) : "its default remote"} in ${projectPath} (${Math.round(performance.now() - started)} ms)`);
    return c.json(ok({ pushed: true }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /git/pull { rebase? } — from the branch's upstream. */
gitRoutes.post("/pull", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const { rebase } = await c.req.json<{ rebase?: boolean }>();
    await gitWorkflowService.pull(projectPath, { rebase });
    return c.json(ok({ pulled: true }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /git/publish — push the current branch and make the remote branch its upstream. */
gitRoutes.post("/publish", async (c) => {
  try {
    return c.json(ok(await gitWorkflowService.publish(c.get("projectPath"))));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/**
 * POST /git/commit/undo { hash } — soft-reset the commit `hash` names, while it
 * is still the last one, and put its message back in the shared message box,
 * unless something is already being written there. 400 without a hash; 409 when
 * it is no longer the last commit, was pushed, is the root commit, or a
 * merge/rebase is under way.
 */
gitRoutes.post("/commit/undo", async (c) => {
  const projectPath = c.get("projectPath");
  const { hash } = await c.req.json<{ hash?: unknown }>().catch(() => ({ hash: undefined }));
  if (typeof hash !== "string" || !hash) return c.json(err("Missing: hash"), 400);
  let undone: { hash: string; message: string };
  try {
    undone = await gitWorkflowService.undoLastCommit(projectPath, hash);
  } catch (e) {
    return c.json(err((e as Error).message), 409);
  }
  let draft = gitCommitDraftService.get(projectPath);
  if (!draft.message.trim()) {
    draft = gitCommitDraftService.set(projectPath, undone.message);
    broadcastCommitDraft(c.get("projectName"), projectPath, draft, null);
  }
  return c.json(ok({ ...undone, draft }));
});

/**
 * POST /git/operation/{abort,continue} — finish or abandon the merge, rebase,
 * cherry-pick, revert or `am` that stopped on a conflict. 409 when there is
 * none, or when continuing with conflicts left.
 */
gitRoutes.post("/operation/:action{abort|continue}", async (c) => {
  try {
    const action = c.req.param("action") as "abort" | "continue";
    return c.json(ok({ kind: await gitWorkflowService.operation(c.get("projectPath"), action) }));
  } catch (e) {
    return c.json(err((e as Error).message), 409);
  }
});

/** GET /git/stashes */
gitRoutes.get("/stashes", async (c) => {
  try {
    return c.json(ok(await gitWorkflowService.listStashes(c.get("projectPath"))));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/**
 * POST /git/stash { message?, includeUntracked? } — answers with the stash it
 * made, or `stashed: false, stash: null` when git found nothing it could save.
 */
gitRoutes.post("/stash", async (c) => {
  try {
    const body = await c.req.json<{ message?: unknown; includeUntracked?: unknown }>().catch(() => ({} as { message?: unknown; includeUntracked?: unknown }));
    const stash = await gitWorkflowService.stash(c.get("projectPath"), {
      message: typeof body.message === "string" ? body.message : undefined,
      includeUntracked: body.includeUntracked === true,
    });
    return c.json(ok({ stashed: !!stash, stash }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /git/stash/{apply,pop,drop} { index, hash } — refused if `stash@{index}` is no longer `hash`. */
for (const action of ["apply", "pop", "drop"] as const) {
  gitRoutes.post(`/stash/${action}`, async (c) => {
    const body = await c.req.json<{ index?: unknown; hash?: unknown }>().catch(() => ({} as { index?: unknown; hash?: unknown }));
    if (typeof body.index !== "number" || typeof body.hash !== "string") return c.json(err("Missing: index, hash"), 400);
    try {
      const result = await gitWorkflowService.stashAction(c.get("projectPath"), action, body.index, body.hash);
      return c.json(ok({ [action]: true, ...result }));
    } catch (e) {
      return c.json(err((e as Error).message), 500);
    }
  });
}

/** POST /git/branch/create { name, from? } */
gitRoutes.post("/branch/create", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const { name, from } = await c.req.json<{ name: string; from?: string }>();
    if (!name) return c.json(err("Missing: name"), 400);
    // Both land as arguments of `git checkout -b`, so neither may open with a dash.
    await gitService.createBranch(
      projectPath,
      assertRef(name, "name"),
      from ? assertRef(from, "from") : undefined,
    );
    log.info(`created and checked out branch ${name} from ${from ?? "HEAD"} in ${projectPath}`);
    return c.json(ok({ created: name }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/**
 * POST /git/checkout { ref, mode? }
 *
 * `mode` is `checkout` (the default), `detach` or `track` — see
 * `GitService.checkout`. It is validated rather than passed through because it
 * decides which flag precedes the ref, and `assertRef` is what stops the ref
 * itself from *being* a flag: an unchecked `-f` here is a forced checkout that
 * discards the working tree.
 */
const CHECKOUT_MODES = new Set<CheckoutMode>(["checkout", "detach", "track"]);

gitRoutes.post("/checkout", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const { ref, mode } = await c.req.json<{ ref: string; mode?: CheckoutMode }>();
    if (!ref) return c.json(err("Missing: ref"), 400);
    if (mode && !CHECKOUT_MODES.has(mode)) {
      return c.json(err(`Unknown checkout mode: "${mode}"`), 400);
    }
    await gitService.checkout(projectPath, assertRef(ref, "ref"), mode);
    log.info(`checked out ${ref} (mode=${mode ?? "checkout"}) in ${projectPath}`);
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
    log.info(`deleted branch ${name} force=${!!force} in ${projectPath}`);
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
    log.info(`merged ${source} into HEAD in ${projectPath}`);
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
