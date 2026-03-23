import { Hono } from "hono";
import { gitService } from "../../services/git.service.ts";
import { ok, err } from "../../types/api.ts";

type Env = { Variables: { projectPath: string; projectName: string } };

export const gitRoutes = new Hono<Env>();

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

/** POST /git/commit { message } */
gitRoutes.post("/commit", async (c) => {
  try {
    const projectPath = c.get("projectPath");
    const { message } = await c.req.json<{ message: string }>();
    if (!message) return c.json(err("Missing: message"), 400);
    const hash = await gitService.commit(projectPath, message);
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
