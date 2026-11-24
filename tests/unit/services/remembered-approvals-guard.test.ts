/**
 * Only a person makes a remembered approval. These hold that by construction: a rule is written in
 * one place, answers reach it only from the chat socket's answer path, no AI tool (MCP endpoints,
 * the Assistant's tools) can reach the store, the routes cannot create one, and the switch cannot
 * be set from a command an AI runs.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import "../../test-setup.ts";
import { configWriteRefusal } from "../../../src/services/config-write-guard.ts";
import { createApprovalRuleRoutes } from "../../../src/server/routes/approval-rules.ts";
import { createRememberedApprovals } from "../../../src/services/remembered-approvals/remembered-approvals.service.ts";
import { getDb } from "../../../src/services/db.service.ts";

const SRC = join(import.meta.dir, "../../../src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}
const files = sourceFiles(SRC).map((p) => ({ rel: relative(SRC, p).replace(/\\/g, "/"), text: readFileSync(p, "utf8") }));

describe("who can make a rule", () => {
  it("writes rules only in the store, and records answers only from the chat's answer path", () => {
    expect(files.filter((f) => /\binsertApprovalRule\(/.test(f.text)).map((f) => f.rel).sort())
      .toEqual(["services/remembered-approvals/remembered-approvals-db.ts", "services/remembered-approvals/remembered-approvals.service.ts"]);
    expect(files.filter((f) => /\.recordAnswer\(/.test(f.text)).map((f) => f.rel)).toEqual(["server/ws/chat.ts"]);
  });

  it("gives no AI tool a way to the rules", () => {
    // The session tools' broker is handed one yes/no question by the chat layer (is this card
    // approved by a rule?) and never sees the store: it is the one file there allowed to name it.
    const toolFiles = files.filter((f) => /(^|\/)(assistant-mcp|tab-tools-mcp|db-ai-tools|session-collab|extension-api|extension-mcp|assistant)\//.test(f.rel)
      && f.rel !== "services/session-collab/collab-approval-broker.ts");
    expect(toolFiles.length).toBeGreaterThan(10);
    for (const f of toolFiles) expect([f.rel, /remembered-approvals|approval-rules|approval_rules/.test(f.text)]).toEqual([f.rel, false]);
  });

  it("offers no route that creates a rule", async () => {
    const routes = createApprovalRuleRoutes(createRememberedApprovals({ now: () => 1, enabled: () => true, setEnabled: () => {} }));
    for (const method of ["POST", "PUT"]) {
      const res = await routes.request("/", { method, body: JSON.stringify({ kind: "command", pattern: "rm -rf /" }), headers: { "content-type": "application/json" } });
      expect(res.status).toBe(404);
    }
    expect(getDb().query("SELECT COUNT(*) AS n FROM approval_rules").get()).toEqual({ n: 0 });
  });

  it("keeps the switch out of `config set`, for a person and an AI chat alike", () => {
    expect(configWriteRefusal("remembered_approvals.enabled", { aiChat: true })).toContain("Settings → Approvals");
    expect(configWriteRefusal("remembered_approvals.enabled", { aiChat: false })).toContain("Settings → Approvals");
  });
});

describe("the routes", () => {
  it("list the rules and the switch, flip the switch, and remove one rule", async () => {
    let enabled = false;
    const service = createRememberedApprovals({ now: () => 5, enabled: () => enabled, setEnabled: (on) => { enabled = on; }, changed: () => {} });
    const routes = createApprovalRuleRoutes(service);
    const json = async (res: Response) => ((await res.json()) as { data: any }).data;
    expect(await json(await routes.request("/"))).toEqual({ enabled: false, rules: [] });
    const put = await routes.request("/enabled", { method: "PUT", body: JSON.stringify({ enabled: true }), headers: { "content-type": "application/json" } });
    expect(await json(put)).toEqual({ enabled: true });
    const req = { tool: "Bash", input: { command: "git status" }, projectPath: "/p/app", projectName: "app" };
    const rule = service.recordAnswer(req, { approved: true, remember: true, origin: "telegram" })!;
    expect((await json(await routes.request("/"))).rules.map((r: { id: string }) => r.id)).toEqual([rule.id]);
    expect((await routes.request(`/${rule.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await routes.request(`/${rule.id}`, { method: "DELETE" })).status).toBe(404);
    expect(service.list()).toEqual([]);
    expect((await routes.request("/enabled", { method: "PUT", body: "{}", headers: { "content-type": "application/json" } })).status).toBe(400);
  });
});
