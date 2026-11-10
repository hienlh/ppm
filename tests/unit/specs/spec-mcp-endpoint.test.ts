/**
 * The spec tools as an agent calls them: over MCP, with a session token, against a real project
 * folder. Covers the binding (no spec, a task chat held to its task, an id that migrated) and
 * that no tool can approve.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

process.env.PPM_HOME = mkdtempSync(join(tmpdir(), "ppm-spec-mcp-home-"));

const { createSpecMcpHandler } = await import("../../../src/services/specs/spec-mcp-endpoint.ts");
const { bindSpecSession, resetSpecSessionsCache } = await import("../../../src/services/specs/spec-store.ts");
const svc = await import("../../../src/services/specs/spec.service.ts");

let project: string;
const migrated = new Map<string, string>();

const app = new Hono();
app.all("/mcp", createSpecMcpHandler({
  resolveToken: (token) => (token ? { sessionId: token } : null),
  canonical: (id) => migrated.get(id) ?? id,
  aliases: (id) => {
    const canonical = migrated.get(id) ?? id;
    return [canonical, ...[...migrated].filter(([, to]) => to === canonical).map(([from]) => from)];
  },
  projectPathOf: () => project,
  isOn: (tool) => tool !== "suite_check",
}));

let rpcId = 0;
async function rpc(session: string, method: string, params: unknown = {}) {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${session}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  return (await res.json()) as { result?: { content?: { text: string }[]; isError?: boolean; tools?: { name: string }[] } };
}
async function call(session: string, name: string, args: unknown = {}) {
  const r = await rpc(session, "tools/call", { name, arguments: args });
  return { text: r.result?.content?.[0]?.text ?? "", error: r.result?.isError === true };
}

const REQ = "# R\n\nUI: no\n\n### Requirement 1: A\n\n#### Acceptance Criteria\n\n1. WHEN x THE SYSTEM SHALL y\n";
const TASKS = "- [ ] 1. One\n  - _Requirements: 1.1_\n  - _Files: a.ts_\n- [ ] 2. Two\n  - _Requirements: 1.1_\n  - _Files: b.ts_\n";

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "ppm-spec-mcp-proj-"));
  resetSpecSessionsCache();
});

describe("spec tools over MCP", () => {
  it("lists only the tools that are on", async () => {
    const names = (await rpc("s0", "tools/list")).result?.tools?.map((t) => t.name) ?? [];
    expect(names).toContain("spec_submit");
    expect(names).not.toContain("suite_check");
    expect(names).not.toContain("spec_approve");
  });

  it("a chat with no spec is told how to start one", async () => {
    const r = await call("s1", "spec_status");
    expect(r.error).toBe(true);
    expect(r.text).toMatch(/spec_create/);
  });

  it("spec_create binds the chat, and submit never approves", async () => {
    const created = await call("s2", "spec_create", { title: "Export chat" });
    expect(created.error).toBe(false);
    expect(created.text).toMatch(/requirements\.md/);
    writeFileSync(join(project, "specs", "export-chat", "requirements.md"), REQ);
    const sub = await call("s2", "spec_submit", { phase: "requirements" });
    expect(sub.error).toBe(false);
    expect(sub.text).toMatch(/wait/i);
    const v = await svc.getSpec(project, "export-chat");
    expect(v.phases.requirements.status).toBe("draft");
    expect(v.phases.requirements.submitted).toBe(true);
    expect((await call("s2", "spec_create", { title: "Another" })).error).toBe(true);
  });

  it("a task chat is held to its own task", async () => {
    await svc.createSpec(project, { title: "S", slug: "s" });
    const dir = join(project, "specs", "s");
    writeFileSync(join(dir, "requirements.md"), REQ);
    await svc.approvePhase(project, "s", "requirements");
    await svc.approvePhase(project, "s", "design");
    writeFileSync(join(dir, "tasks.md"), TASKS);
    await svc.approvePhase(project, "s", "tasks");
    bindSpecSession("child", { projectPath: project, slug: "s", taskId: "1" });
    expect((await call("child", "task_start", { task: "2" })).text).toMatch(/task 1 only/);
    expect((await call("child", "task_start")).error).toBe(false);
    expect((await call("child", "task_done", { summary: "did it" })).error).toBe(false);
    expect((await call("child", "spec_submit", { phase: "tasks" })).error).toBe(true);
    expect((await svc.getSpec(project, "s")).tasks[0]!.done).toBe(true);
  });

  it("finds a spec bound before the chat's id migrated", async () => {
    await svc.createSpec(project, { title: "M", slug: "m", sessionId: "old-id" });
    migrated.set("old-id", "new-id");
    const r = await call("new-id", "spec_status");
    expect(r.error).toBe(false);
    expect(r.text).toContain('Spec "M"');
  });
});
