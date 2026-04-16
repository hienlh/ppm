import { describe, it, expect, beforeEach } from "bun:test";
import "../../test-setup.ts";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setKeyPath } from "../../../src/lib/account-crypto.ts";
import { openTestDb, setDb, getDb } from "../../../src/services/db.service.ts";
import { app } from "../../../src/server/index.ts";

const testKeyPath = resolve(tmpdir(), `ppm-jira-api-${Date.now()}.key`);
setKeyPath(testKeyPath);

let projectId: number;

beforeEach(() => {
  const db = openTestDb();
  setDb(db);
  db.query("INSERT INTO projects (path, name, sort_order) VALUES ('/tmp/jtest', 'jtest', 0)").run();
  projectId = (db.query("SELECT id FROM projects WHERE name = 'jtest'").get() as { id: number }).id;
});

async function req(path: string, init?: RequestInit) {
  const url = `http://localhost${path}`;
  const headers = new Headers(init?.headers);
  if (!headers.has("Content-Type") && init?.body) headers.set("Content-Type", "application/json");
  return app.request(new Request(url, { ...init, headers }));
}

describe("Jira Config API", () => {
  it("GET /api/jira/config returns empty initially", async () => {
    const res = await req("/api/jira/config");
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(json.data).toEqual([]);
  });

  it("PUT /api/jira/config/:projectId creates config", async () => {
    const res = await req(`/api/jira/config/${projectId}`, {
      method: "PUT",
      body: JSON.stringify({ baseUrl: "https://test.atlassian.net", email: "a@b.com", token: "tok123" }),
    });
    const json = await res.json() as any;
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.data.baseUrl).toBe("https://test.atlassian.net");
    expect(json.data.hasToken).toBe(true);
  });

  it("GET /api/jira/config/:projectId returns config", async () => {
    await req(`/api/jira/config/${projectId}`, {
      method: "PUT",
      body: JSON.stringify({ baseUrl: "https://test.atlassian.net", email: "a@b.com", token: "tok" }),
    });
    const res = await req(`/api/jira/config/${projectId}`);
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(json.data.email).toBe("a@b.com");
  });

  it("DELETE /api/jira/config/:projectId removes config", async () => {
    await req(`/api/jira/config/${projectId}`, {
      method: "PUT",
      body: JSON.stringify({ baseUrl: "https://test.atlassian.net", email: "a@b.com", token: "tok" }),
    });
    const res = await req(`/api/jira/config/${projectId}`, { method: "DELETE" });
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(json.data.deleted).toBe(true);
  });

  it("PUT validates required fields", async () => {
    const res = await req(`/api/jira/config/${projectId}`, {
      method: "PUT",
      body: JSON.stringify({ baseUrl: "https://x.atlassian.net" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("Jira Watcher API", () => {
  let configId: number;

  beforeEach(async () => {
    const res = await req(`/api/jira/config/${projectId}`, {
      method: "PUT",
      body: JSON.stringify({ baseUrl: "https://test.atlassian.net", email: "a@b.com", token: "tok" }),
    });
    configId = ((await res.json()) as any).data.id;
  });

  it("POST /api/jira/watchers creates watcher", async () => {
    const res = await req("/api/jira/watchers", {
      method: "POST",
      body: JSON.stringify({ configId, name: "bug-watcher", jql: "project=BUG" }),
    });
    const json = await res.json() as any;
    expect(res.status).toBe(201);
    expect(json.data.name).toBe("bug-watcher");
    expect(json.data.enabled).toBe(true);
  });

  it("GET /api/jira/watchers?configId returns watchers", async () => {
    await req("/api/jira/watchers", {
      method: "POST",
      body: JSON.stringify({ configId, name: "w1", jql: "x=y" }),
    });
    const res = await req(`/api/jira/watchers?configId=${configId}`);
    const json = await res.json() as any;
    expect(json.data).toHaveLength(1);
  });

  it("DELETE /api/jira/watchers/:id removes watcher", async () => {
    const create = await req("/api/jira/watchers", {
      method: "POST",
      body: JSON.stringify({ configId, name: "del", jql: "x=y" }),
    });
    const wId = ((await create.json()) as any).data.id;
    const res = await req(`/api/jira/watchers/${wId}`, { method: "DELETE" });
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
  });

  it("GET /api/jira/results returns empty", async () => {
    const res = await req("/api/jira/results");
    const json = await res.json() as any;
    expect(json.ok).toBe(true);
    expect(json.data).toEqual([]);
  });

  it("DELETE /api/jira/results/:id soft-deletes", async () => {
    // Insert result directly
    const db = getDb();
    const wRes = await req("/api/jira/watchers", {
      method: "POST",
      body: JSON.stringify({ configId, name: "r-w", jql: "x=y" }),
    });
    const wId = ((await wRes.json()) as any).data.id;
    db.query("INSERT INTO jira_watch_results (watcher_id, issue_key) VALUES (?, 'RD-1')").run(wId);
    const rId = (db.query("SELECT id FROM jira_watch_results WHERE issue_key = 'RD-1'").get() as { id: number }).id;

    const res = await req(`/api/jira/results/${rId}`, { method: "DELETE" });
    const json = await res.json() as any;
    expect(json.ok).toBe(true);

    // Should be excluded from default query
    const listRes = await req("/api/jira/results");
    const listJson = await listRes.json() as any;
    expect(listJson.data.find((r: any) => r.id === rId)).toBeUndefined();
  });
});
