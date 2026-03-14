import { Hono } from "hono";
import { resolve } from "path";
import { gitService } from "../../services/git.service.ts";
import { configService } from "../../services/config.service.ts";

/** Resolve project name or path to absolute path */
function resolveProjectPath(nameOrPath: string): string {
  const projects = configService.get("projects");
  // Try by name first
  const byName = projects.find((p) => p.name === nameOrPath);
  if (byName) return resolve(byName.path);
  // Fall back to path validation
  const abs = resolve(nameOrPath);
  const allowed = projects.some((p) => abs === p.path || abs.startsWith(p.path + "/"));
  if (!allowed) throw new Error(`Project not found: ${nameOrPath}`);
  return abs;
}

export function createGitRoutes() {
  const app = new Hono();

  app.get("/status/:project", async (c) => {
    try {
      const project = decodeURIComponent(c.req.param("project"));
      const path = resolveProjectPath(project);
      const data = await gitService.status(path);
      return c.json({ ok: true, data });
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 500);
    }
  });

  app.get("/diff/:project", async (c) => {
    try {
      const project = decodeURIComponent(c.req.param("project"));
      const path = resolveProjectPath(project);
      const ref1 = c.req.query("ref1");
      const ref2 = c.req.query("ref2");
      const diff = await gitService.diff(path, ref1, ref2);
      return c.json({ ok: true, data: { diff } });
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 500);
    }
  });

  app.get("/file-diff/:project", async (c) => {
    try {
      const project = decodeURIComponent(c.req.param("project"));
      const path = resolveProjectPath(project);
      const file = c.req.query("file");
      const ref = c.req.query("ref");
      if (!file) return c.json({ ok: false, error: "file is required" }, 400);
      const diff = await gitService.fileDiff(path, file, ref);
      return c.json({ ok: true, data: { diff, file } });
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 500);
    }
  });

  app.get("/graph/:project", async (c) => {
    try {
      const project = decodeURIComponent(c.req.param("project"));
      const path = resolveProjectPath(project);
      const max = parseInt(c.req.query("max") ?? "200", 10);
      const data = await gitService.graphData(path, max);
      return c.json({ ok: true, data });
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 500);
    }
  });

  app.get("/branches/:project", async (c) => {
    try {
      const project = decodeURIComponent(c.req.param("project"));
      const path = resolveProjectPath(project);
      const data = await gitService.branches(path);
      return c.json({ ok: true, data });
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 500);
    }
  });

  app.get("/pr-url/:project", async (c) => {
    try {
      const project = decodeURIComponent(c.req.param("project"));
      const path = resolveProjectPath(project);
      const branch = c.req.query("branch");
      if (!branch) return c.json({ ok: false, error: "branch is required" }, 400);
      const url = await gitService.getCreatePrUrl(path, branch);
      return c.json({ ok: true, data: { url } });
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 500);
    }
  });

  app.post("/stage", async (c) => {
    try {
      const body = await c.req.json<{ project: string; files: string[] }>();
      const path = resolveProjectPath(body.project);
      await gitService.stage(path, body.files);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 500);
    }
  });

  app.post("/unstage", async (c) => {
    try {
      const body = await c.req.json<{ project: string; files: string[] }>();
      const path = resolveProjectPath(body.project);
      await gitService.unstage(path, body.files);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 500);
    }
  });

  app.post("/commit", async (c) => {
    try {
      const body = await c.req.json<{ project: string; message: string }>();
      const path = resolveProjectPath(body.project);
      const hash = await gitService.commit(path, body.message);
      return c.json({ ok: true, data: { hash } });
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 500);
    }
  });

  app.post("/push", async (c) => {
    try {
      const body = await c.req.json<{ project: string; remote?: string; branch?: string }>();
      const path = resolveProjectPath(body.project);
      await gitService.push(path, body.remote, body.branch);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 500);
    }
  });

  app.post("/pull", async (c) => {
    try {
      const body = await c.req.json<{ project: string; remote?: string; branch?: string }>();
      const path = resolveProjectPath(body.project);
      await gitService.pull(path, body.remote, body.branch);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 500);
    }
  });

  app.post("/branch/create", async (c) => {
    try {
      const body = await c.req.json<{ project: string; name: string; from?: string }>();
      const path = resolveProjectPath(body.project);
      await gitService.createBranch(path, body.name, body.from);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 500);
    }
  });

  app.post("/checkout", async (c) => {
    try {
      const body = await c.req.json<{ project: string; ref: string }>();
      const path = resolveProjectPath(body.project);
      await gitService.checkout(path, body.ref);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 500);
    }
  });

  app.post("/branch/delete", async (c) => {
    try {
      const body = await c.req.json<{ project: string; name: string; force?: boolean }>();
      const path = resolveProjectPath(body.project);
      await gitService.deleteBranch(path, body.name, body.force);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 500);
    }
  });

  app.post("/merge", async (c) => {
    try {
      const body = await c.req.json<{ project: string; source: string }>();
      const path = resolveProjectPath(body.project);
      await gitService.merge(path, body.source);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 500);
    }
  });

  app.post("/cherry-pick", async (c) => {
    try {
      const body = await c.req.json<{ project: string; hash: string }>();
      const path = resolveProjectPath(body.project);
      await gitService.cherryPick(path, body.hash);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 500);
    }
  });

  app.post("/revert", async (c) => {
    try {
      const body = await c.req.json<{ project: string; hash: string }>();
      const path = resolveProjectPath(body.project);
      await gitService.revert(path, body.hash);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 500);
    }
  });

  app.post("/tag", async (c) => {
    try {
      const body = await c.req.json<{ project: string; name: string; hash?: string }>();
      const path = resolveProjectPath(body.project);
      await gitService.createTag(path, body.name, body.hash);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 500);
    }
  });

  return app;
}
