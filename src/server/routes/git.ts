import { Hono } from "hono";
import { resolveProjectPath } from "../helpers/resolve-project.ts";
import { gitService } from "../../services/git.service.ts";
import { ok, err } from "../../types/api.ts";

export const gitRoutes = new Hono();

/** GET /api/git/status/:project */
gitRoutes.get("/status/:project", async (c) => {
  try {
    const projectPath = resolveProjectPath(c.req.param("project"));
    const status = await gitService.status(projectPath);
    return c.json(ok(status));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** GET /api/git/diff/:project?ref1=&ref2= */
gitRoutes.get("/diff/:project", async (c) => {
  try {
    const projectPath = resolveProjectPath(c.req.param("project"));
    const ref1 = c.req.query("ref1") || undefined;
    const ref2 = c.req.query("ref2") || undefined;
    const diff = await gitService.diff(projectPath, ref1, ref2);
    return c.json(ok({ diff }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** GET /api/git/file-diff/:project?file=&ref= */
gitRoutes.get("/file-diff/:project", async (c) => {
  try {
    const projectPath = resolveProjectPath(c.req.param("project"));
    const file = c.req.query("file");
    if (!file) return c.json(err("Missing query: file"), 400);
    const ref = c.req.query("ref") || undefined;
    const diff = await gitService.fileDiff(projectPath, file, ref);
    return c.json(ok({ diff }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** GET /api/git/graph/:project?max=200 */
gitRoutes.get("/graph/:project", async (c) => {
  try {
    const projectPath = resolveProjectPath(c.req.param("project"));
    const max = parseInt(c.req.query("max") ?? "200", 10);
    const data = await gitService.graphData(projectPath, max);
    return c.json(ok(data));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** GET /api/git/branches/:project */
gitRoutes.get("/branches/:project", async (c) => {
  try {
    const projectPath = resolveProjectPath(c.req.param("project"));
    const branches = await gitService.branches(projectPath);
    return c.json(ok(branches));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /api/git/stage { project, files } */
gitRoutes.post("/stage", async (c) => {
  try {
    const { project, files } = await c.req.json<{ project: string; files: string[] }>();
    if (!project || !files?.length) return c.json(err("Missing: project, files"), 400);
    const projectPath = resolveProjectPath(project);
    await gitService.stage(projectPath, files);
    return c.json(ok({ staged: files }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /api/git/unstage { project, files } */
gitRoutes.post("/unstage", async (c) => {
  try {
    const { project, files } = await c.req.json<{ project: string; files: string[] }>();
    if (!project || !files?.length) return c.json(err("Missing: project, files"), 400);
    const projectPath = resolveProjectPath(project);
    await gitService.unstage(projectPath, files);
    return c.json(ok({ unstaged: files }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /api/git/commit { project, message } */
gitRoutes.post("/commit", async (c) => {
  try {
    const { project, message } = await c.req.json<{ project: string; message: string }>();
    if (!project || !message) return c.json(err("Missing: project, message"), 400);
    const projectPath = resolveProjectPath(project);
    const hash = await gitService.commit(projectPath, message);
    return c.json(ok({ hash }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /api/git/push { project, remote?, branch? } */
gitRoutes.post("/push", async (c) => {
  try {
    const { project, remote, branch } = await c.req.json<{
      project: string; remote?: string; branch?: string;
    }>();
    if (!project) return c.json(err("Missing: project"), 400);
    const projectPath = resolveProjectPath(project);
    await gitService.push(projectPath, remote, branch);
    return c.json(ok({ pushed: true }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /api/git/pull { project, remote?, branch? } */
gitRoutes.post("/pull", async (c) => {
  try {
    const { project, remote, branch } = await c.req.json<{
      project: string; remote?: string; branch?: string;
    }>();
    if (!project) return c.json(err("Missing: project"), 400);
    const projectPath = resolveProjectPath(project);
    await gitService.pull(projectPath, remote, branch);
    return c.json(ok({ pulled: true }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /api/git/branch/create { project, name, from? } */
gitRoutes.post("/branch/create", async (c) => {
  try {
    const { project, name, from } = await c.req.json<{
      project: string; name: string; from?: string;
    }>();
    if (!project || !name) return c.json(err("Missing: project, name"), 400);
    const projectPath = resolveProjectPath(project);
    await gitService.createBranch(projectPath, name, from);
    return c.json(ok({ created: name }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /api/git/checkout { project, ref } */
gitRoutes.post("/checkout", async (c) => {
  try {
    const { project, ref } = await c.req.json<{ project: string; ref: string }>();
    if (!project || !ref) return c.json(err("Missing: project, ref"), 400);
    const projectPath = resolveProjectPath(project);
    await gitService.checkout(projectPath, ref);
    return c.json(ok({ checkedOut: ref }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /api/git/branch/delete { project, name, force? } */
gitRoutes.post("/branch/delete", async (c) => {
  try {
    const { project, name, force } = await c.req.json<{
      project: string; name: string; force?: boolean;
    }>();
    if (!project || !name) return c.json(err("Missing: project, name"), 400);
    const projectPath = resolveProjectPath(project);
    await gitService.deleteBranch(projectPath, name, force);
    return c.json(ok({ deleted: name }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /api/git/merge { project, source } */
gitRoutes.post("/merge", async (c) => {
  try {
    const { project, source } = await c.req.json<{ project: string; source: string }>();
    if (!project || !source) return c.json(err("Missing: project, source"), 400);
    const projectPath = resolveProjectPath(project);
    await gitService.merge(projectPath, source);
    return c.json(ok({ merged: source }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /api/git/cherry-pick { project, hash } */
gitRoutes.post("/cherry-pick", async (c) => {
  try {
    const { project, hash } = await c.req.json<{ project: string; hash: string }>();
    if (!project || !hash) return c.json(err("Missing: project, hash"), 400);
    const projectPath = resolveProjectPath(project);
    await gitService.cherryPick(projectPath, hash);
    return c.json(ok({ cherryPicked: hash }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /api/git/revert { project, hash } */
gitRoutes.post("/revert", async (c) => {
  try {
    const { project, hash } = await c.req.json<{ project: string; hash: string }>();
    if (!project || !hash) return c.json(err("Missing: project, hash"), 400);
    const projectPath = resolveProjectPath(project);
    await gitService.revert(projectPath, hash);
    return c.json(ok({ reverted: hash }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** POST /api/git/tag { project, name, hash? } */
gitRoutes.post("/tag", async (c) => {
  try {
    const { project, name, hash } = await c.req.json<{
      project: string; name: string; hash?: string;
    }>();
    if (!project || !name) return c.json(err("Missing: project, name"), 400);
    const projectPath = resolveProjectPath(project);
    await gitService.createTag(projectPath, name, hash);
    return c.json(ok({ tagged: name }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** GET /api/git/pr-url/:project?branch= */
gitRoutes.get("/pr-url/:project", async (c) => {
  try {
    const projectPath = resolveProjectPath(c.req.param("project"));
    const branch = c.req.query("branch");
    if (!branch) return c.json(err("Missing query: branch"), 400);
    const url = await gitService.getCreatePrUrl(projectPath, branch);
    return c.json(ok({ url }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});
