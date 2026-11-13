/**
 * A Jira token is entered for one site and one account. When a save moves the config to another
 * host or email without a new token, the route clears the saved token for every caller and says
 * so (`tokenCleared`), and a connection test then sends nothing — no credential reaches the new
 * site. Jira writes announce `jira:config_changed` / `jira:watchers_changed`; reads and refused
 * writes announce nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Hono } from "hono";
import { setKeyPath } from "../../../src/lib/account-crypto.ts";
import { openTestDb, setDb } from "../../../src/services/db.service.ts";
import { jiraRoutes } from "../../../src/server/routes/jira.ts";
import { jiraEndpointChanged } from "../../../src/server/routes/jira-config-routes.ts";
import { ANNOUNCE_JIRA_ENV_KEY, jiraEventFor } from "../../../src/server/routes/jira-broadcast.ts";
import { JIRA_NO_TOKEN_MESSAGE, getDecryptedCredentials } from "../../../src/services/jira-config.service.ts";
import { jiraWatcherService } from "../../../src/services/jira-watcher.service.ts";

setKeyPath(resolve(tmpdir(), `ppm-jira-endpoint-${Date.now()}.key`));

let projectId: number;
let announced: string[];
const realFetch = globalThis.fetch;
let outgoing: Array<{ url: string; auth: string | null }>;

const app = new Hono().route("/api/jira", jiraRoutes);

async function call(method: string, path: string, body?: unknown) {
  const res = await app.request(`http://ppm.local/api/jira${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
  }, { [ANNOUNCE_JIRA_ENV_KEY]: (type: string) => announced.push(type) });
  return { status: res.status, json: await res.json() as { ok: boolean; data: any; error?: string } };
}

beforeEach(() => {
  const db = openTestDb();
  setDb(db);
  db.query("INSERT INTO projects (path, name, sort_order) VALUES ('/tmp/jira-endpoint', 'jira-endpoint', 0)").run();
  projectId = (db.query("SELECT id FROM projects WHERE name = 'jira-endpoint'").get() as { id: number }).id;
  announced = [];
  outgoing = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    outgoing.push({ url: String(input), auth: headers.get("Authorization") });
    return new Response(JSON.stringify({ issues: [], total: 0 }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  jiraWatcherService.stopAll();
});

describe("a new Jira site or email without a new token", () => {
  it("clears the saved token, and a test then sends nothing to the new site", async () => {
    await call("PUT", `/config/${projectId}`, { baseUrl: "https://first.example", email: "me@example.com", token: "first-site-token" });
    const moved = await call("PUT", `/config/${projectId}`, { baseUrl: "https://other.example", email: "me@example.com" });
    expect(moved.status).toBe(200);
    expect(moved.json.data).toMatchObject({ baseUrl: "https://other.example", hasToken: false, tokenCleared: true });
    expect(getDecryptedCredentials(moved.json.data.id)).toBeNull();

    const test = await call("POST", `/config/${projectId}/test`);
    expect(test.status).toBe(400);
    expect(test.json.error).toBe(JIRA_NO_TOKEN_MESSAGE);
    expect(outgoing).toEqual([]);
  });

  it("clears it on an email change too, and keeps it for the same host and email", async () => {
    await call("PUT", `/config/${projectId}`, { baseUrl: "https://site.example", email: "me@example.com", token: "tok" });
    const samePlace = await call("PUT", `/config/${projectId}`, { baseUrl: "https://site.example/", email: "ME@example.com" });
    expect(samePlace.json.data).toMatchObject({ hasToken: true });
    expect(samePlace.json.data.tokenCleared).toBeUndefined();
    const otherMail = await call("PUT", `/config/${projectId}`, { baseUrl: "https://site.example", email: "you@example.com" });
    expect(otherMail.json.data).toMatchObject({ hasToken: false, tokenCleared: true });
  });

  it("sends the token only to the site it was entered for", async () => {
    await call("PUT", `/config/${projectId}`, { baseUrl: "https://first.example", email: "me@example.com", token: "first-site-token" });
    await call("PUT", `/config/${projectId}`, { baseUrl: "https://other.example", email: "me@example.com", token: "other-site-token" });
    await call("POST", `/config/${projectId}/test`);
    expect(outgoing.length).toBe(1);
    expect(outgoing[0]!.url.startsWith("https://other.example/")).toBe(true);
    expect(Buffer.from(outgoing[0]!.auth!.replace(/^Basic /, ""), "base64").toString()).toBe("me@example.com:other-site-token");
  });

  it("makes a watcher's dry run say the token is missing", async () => {
    const saved = await call("PUT", `/config/${projectId}`, { baseUrl: "https://first.example", email: "me@example.com", token: "tok" });
    await call("PUT", `/config/${projectId}`, { baseUrl: "https://other.example", email: "me@example.com" });
    const dry = await call("POST", "/watchers/test-jql", { configId: saved.json.data.id, jql: "project = X" });
    expect(dry.json.error).toBe(JIRA_NO_TOKEN_MESSAGE);
    expect(outgoing).toEqual([]);
  });
});

describe("jiraEndpointChanged", () => {
  const was = { baseUrl: "https://a.example/jira", email: "Me@Example.com" };
  it("compares the host and the email, not the path or the case", () => {
    expect(jiraEndpointChanged(was, "https://a.example/other", "me@example.com")).toBe(false);
    expect(jiraEndpointChanged(was, "https://b.example/jira", "me@example.com")).toBe(true);
    expect(jiraEndpointChanged(was, "https://a.example:8443/jira", "me@example.com")).toBe(true);
    expect(jiraEndpointChanged(was, "https://a.example/jira", "you@example.com")).toBe(true);
  });
});

describe("Jira change announcements", () => {
  it("announce config and watcher writes, never reads, tests or refused writes", async () => {
    const saved = await call("PUT", `/config/${projectId}`, { baseUrl: "https://a.example", email: "me@example.com", token: "tok" });
    const configId = saved.json.data.id;
    const watcher = await call("POST", "/watchers", { configId, name: "w", jql: "project = X" });
    await call("PUT", `/watchers/${watcher.json.data.id}`, { enabled: false });
    await call("GET", `/watchers?configId=${configId}`);
    await call("GET", `/watchers/${watcher.json.data.id}`);
    await call("POST", `/config/${projectId}/test`);
    await call("PUT", `/config/${projectId}`, { baseUrl: "http://plain.example", email: "me@example.com" });
    await call("DELETE", `/watchers/${watcher.json.data.id}`);
    await call("DELETE", "/watchers/99999");
    expect(announced).toEqual(["jira:config_changed", "jira:watchers_changed", "jira:watchers_changed", "jira:watchers_changed"]);
  });

  it("maps paths to events", () => {
    expect(jiraEventFor("DELETE", "/config/3")).toBe("jira:config_changed");
    expect(jiraEventFor("POST", "/config/3/test")).toBeNull();
    expect(jiraEventFor("POST", "/watchers/test-jql")).toBeNull();
    expect(jiraEventFor("POST", "/watchers/pull-all")).toBe("jira:watchers_changed");
    expect(jiraEventFor("POST", "/watchers/4/pull")).toBe("jira:watchers_changed");
    expect(jiraEventFor("POST", "/results/manual")).toBe("jira:watchers_changed");
    expect(jiraEventFor("PATCH", "/results/9/read")).toBe("jira:watchers_changed");
    expect(jiraEventFor("PUT", "/ticket/1/PROJ-1")).toBeNull();
    expect(jiraEventFor("POST", "/results/9/debug")).toBeNull();
  });
});
