import { describe, it, expect, beforeEach } from "bun:test";
import { Hono } from "hono";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";
import { gitRoutes } from "../../../src/server/routes/git.ts";

type Env = { Variables: { projectPath: string; projectName: string } };

function createApp() {
  const app = new Hono<Env>();
  app.use("/*", async (c, next) => {
    c.set("projectPath", "/tmp");
    c.set("projectName", "test-project");
    await next();
  });
  app.route("/git", gitRoutes);
  return app;
}

beforeEach(() => {
  setDb(openTestDb());
});

describe("POST /git/discard — input validation", () => {
  it("rejects missing files array", async () => {
    const app = createApp();
    const res = await app.request("/git/discard", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error).toContain("Missing");
  });

  it("rejects empty files array", async () => {
    const app = createApp();
    const res = await app.request("/git/discard", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files: [] }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /git/stage — input validation", () => {
  it("rejects missing files array", async () => {
    const app = createApp();
    const res = await app.request("/git/stage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  it("rejects empty files array", async () => {
    const app = createApp();
    const res = await app.request("/git/stage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files: [] }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /git/unstage — input validation", () => {
  it("rejects missing files array", async () => {
    const app = createApp();
    const res = await app.request("/git/unstage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("rejects empty files array", async () => {
    const app = createApp();
    const res = await app.request("/git/unstage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files: [] }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /git/commit — input validation", () => {
  it("rejects missing message", async () => {
    const app = createApp();
    const res = await app.request("/git/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  it("rejects empty message", async () => {
    const app = createApp();
    const res = await app.request("/git/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /git/branch/create — input validation", () => {
  it("rejects missing name", async () => {
    const app = createApp();
    const res = await app.request("/git/branch/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  it("rejects empty name", async () => {
    const app = createApp();
    const res = await app.request("/git/branch/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /git/checkout — input validation", () => {
  it("rejects missing ref", async () => {
    const app = createApp();
    const res = await app.request("/git/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  it("rejects empty ref", async () => {
    const app = createApp();
    const res = await app.request("/git/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /git/branch/delete — input validation", () => {
  it("rejects missing name", async () => {
    const app = createApp();
    const res = await app.request("/git/branch/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("rejects empty name", async () => {
    const app = createApp();
    const res = await app.request("/git/branch/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /git/merge — input validation", () => {
  it("rejects missing source", async () => {
    const app = createApp();
    const res = await app.request("/git/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  it("rejects empty source", async () => {
    const app = createApp();
    const res = await app.request("/git/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /git/cherry-pick — input validation", () => {
  it("rejects missing hash", async () => {
    const app = createApp();
    const res = await app.request("/git/cherry-pick", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("rejects empty hash", async () => {
    const app = createApp();
    const res = await app.request("/git/cherry-pick", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hash: "" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /git/revert — input validation", () => {
  it("rejects missing hash", async () => {
    const app = createApp();
    const res = await app.request("/git/revert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("rejects empty hash", async () => {
    const app = createApp();
    const res = await app.request("/git/revert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hash: "" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /git/tag — input validation", () => {
  it("rejects missing name", async () => {
    const app = createApp();
    const res = await app.request("/git/tag", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("rejects empty name", async () => {
    const app = createApp();
    const res = await app.request("/git/tag", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /git/worktree/add — input validation", () => {
  it("rejects missing path", async () => {
    const app = createApp();
    const res = await app.request("/git/worktree/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("rejects empty path", async () => {
    const app = createApp();
    const res = await app.request("/git/worktree/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /git/worktree/remove — input validation", () => {
  it("rejects missing path", async () => {
    const app = createApp();
    const res = await app.request("/git/worktree/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("rejects empty path", async () => {
    const app = createApp();
    const res = await app.request("/git/worktree/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /git/file-diff?file= — query validation", () => {
  it("rejects missing file query param", async () => {
    const app = createApp();
    const res = await app.request("/git/file-diff");
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  it("accepts file query param with optional ref", async () => {
    const app = createApp();
    // Will fail with git error (not a repo) but not validation error (500)
    const res = await app.request("/git/file-diff?file=package.json&ref=main");
    expect(res.status).toBe(500);
  });
});

describe("GET /git/pr-url?branch= — query validation", () => {
  it("rejects missing branch query param", async () => {
    const app = createApp();
    const res = await app.request("/git/pr-url");
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });
});
