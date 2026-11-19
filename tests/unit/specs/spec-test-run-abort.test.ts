/**
 * A spec's test run belongs to the tool call that asked for it: when the chat stops that call,
 * PPM stops the run — every process under it, not only the shell — and records nothing. Before,
 * a stopped `task_green` left a VM test running for minutes unseen while the task looked failed.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

const home = mkdtempSync(join(tmpdir(), "ppm-spec-abort-home-"));
process.env.PPM_HOME = home;

const svc = await import("../../../src/services/specs/spec.service.ts");
const { runTestCommand } = await import("../../../src/services/specs/test-runner.ts");
const { resetSpecSessionsCache, bindSpecSession } = await import("../../../src/services/specs/spec-store.ts");
const { createSpecMcpHandler } = await import("../../../src/services/specs/spec-mcp-endpoint.ts");

let project: string;
const write = (rel: string, text: string) => writeFileSync(join(project, rel), text);
const specFile = (name: string) => join(project, "specs", "slow", name);

const REQ = "# Requirements: Slow\n\nUI: no\n\n### Requirement 1: Wait\n\n#### Acceptance Criteria\n\n1. WHEN asked THE SYSTEM SHALL wait\n";
// The task command blocks until a marker file appears, so the test decides when a run would end.
const DESIGN = "# Design: Slow\n\n```ppm-test\ntask: sh ./run.sh {files}\nsuite: sh ./run.sh\n```\n";
const TASKS = "# Implementation Plan: Slow\n\n- [ ] 1. Wait\n  - _Requirements: 1.1_\n  - _Files: slow.ts, slow.test.sh_\n  - _Test: slow.test.sh_\n";

/** Polls until `check` holds, or fails after `ms`. */
async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(25);
  }
}

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

/** A Thorough spec whose test command blocks until `release` exists (writing `started` first). */
async function approvedSlowSpec(): Promise<void> {
  await svc.createSpec(project, { title: "Slow", slug: "slow", checks: "thorough", sessionId: "chat-slow" });
  write("run.sh", "#!/bin/sh\ntouch started\nwhile [ ! -f release ]; do sleep 0.05; done\nexit 1\n");
  writeFileSync(specFile("requirements.md"), REQ);
  expect((await svc.approvePhase(project, "slow", "requirements")).ok).toBe(true);
  writeFileSync(specFile("design.md"), DESIGN);
  expect((await svc.approvePhase(project, "slow", "design")).ok).toBe(true);
  writeFileSync(specFile("tasks.md"), TASKS);
  // The baseline suite run starts on this approval: let it finish first.
  const approved = svc.approvePhase(project, "slow", "tasks");
  await until(() => existsSync(join(project, "started")));
  write("release", "");
  expect((await approved).ok).toBe(true);
  await svc.baselineSettled(project, "slow");
  rmSync(join(project, "release"));
  rmSync(join(project, "started"));
}

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "ppm-spec-abort-proj-"));
  resetSpecSessionsCache();
});
// A failed assertion must not leave a run waiting forever for its release file.
afterEach(() => write("release", ""));
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe.skipIf(process.platform === "win32")("stopping a test run", () => {
  it("kills every process under the shell, grandchildren included, and reports the run as aborted", async () => {
    // A runner three levels deep, like scripts/test.sh -> a VM test -> its helpers.
    write("deep.sh", "#!/bin/sh\nsh -c 'sleep 60 & echo $! > grandchild.pid; wait' &\necho $! > child.pid\nwait\n");
    const ctl = new AbortController();
    const running = runTestCommand("sh ./deep.sh", project, 60_000, ctl.signal);
    await until(() => existsSync(join(project, "grandchild.pid")) && readFileSync(join(project, "grandchild.pid"), "utf8").trim() !== "");
    const grandchild = Number(readFileSync(join(project, "grandchild.pid"), "utf8"));
    const child = Number(readFileSync(join(project, "child.pid"), "utf8"));
    expect(alive(grandchild)).toBe(true);

    const t0 = Date.now();
    ctl.abort();
    const run = await running;
    expect(run.aborted).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2_000);
    await until(() => !alive(grandchild) && !alive(child));
  }, 20_000);

  it("a run nobody stops is not marked aborted", async () => {
    const run = await runTestCommand("exit 0", project, 10_000, new AbortController().signal);
    expect(run.aborted).toBeUndefined();
    expect(run.verdict.outcome).not.toBe("broken");
  });

  it("a red the agent's CLI gives up on over HTTP is stopped on the server", async () => {
    await approvedSlowSpec();
    expect((await svc.startTask(project, "slow", "1")).ok).toBe(true);
    write("slow.test.sh", "exit 1\n");
    bindSpecSession("chat-http", { projectPath: project, slug: "slow" });

    const app = new Hono();
    app.all("/mcp", createSpecMcpHandler({
      resolveToken: (token) => (token ? { sessionId: token } : null),
      canonical: (id) => id,
      aliases: (id) => [id],
      projectPathOf: () => project,
      isOn: () => true,
    }));
    // A real server: the abort has to come from the client closing the connection.
    const server = Bun.serve({ port: 0, idleTimeout: 0, fetch: (req, srv) => app.fetch(req, srv) });
    try {
      const ctl = new AbortController();
      const pending = fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: "POST",
        signal: ctl.signal,
        headers: { "content-type": "application/json", authorization: "Bearer chat-http" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "task_red", arguments: { task: "1" } } }),
      }).catch(() => null);
      await until(() => existsSync(join(project, "started")));
      expect((await svc.getSpec(project, "slow")).tasks[0].testing?.kind).toBe("red");
      ctl.abort();
      await pending;
      // The run ends on the server without the release file ever appearing.
      const end = Date.now() + 5_000;
      while ((await svc.getSpec(project, "slow")).tasks[0].testing !== null) {
        if (Date.now() > end) throw new Error("the run kept going after the client gave up");
        await Bun.sleep(25);
      }
      const after = await svc.getSpec(project, "slow");
      expect(after.tasks[0].status).toBe("running");
      expect(after.tasks[0].run?.red).toBeUndefined();
    } finally {
      server.stop(true);
    }
  }, 30_000);

  it("a stopped red records nothing, shows the run while it lasts, and a second call meanwhile is refused", async () => {
    await approvedSlowSpec();

    expect((await svc.startTask(project, "slow", "1")).ok).toBe(true);
    write("slow.test.sh", "exit 1\n");

    const ctl = new AbortController();
    const red = svc.taskRed(project, "slow", "1", ctl.signal);
    await until(() => existsSync(join(project, "started")));

    const during = await svc.getSpec(project, "slow");
    expect(during.tasks[0].testing?.kind).toBe("red");
    const second = await svc.taskRed(project, "slow", "1");
    expect(second.ok).toBe(false);
    expect(second.message).toMatch(/already running/);

    ctl.abort();
    const r = await red;
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/^Stopped/);
    const after = await svc.getSpec(project, "slow");
    expect(after.tasks[0].status).toBe("running");
    expect(after.tasks[0].run?.red).toBeUndefined();
    expect(after.tasks[0].run?.lastRun).toBeUndefined();
    expect(after.tasks[0].testing).toBeNull();

    // Called again with nothing stopping it, the same red goes through.
    write("release", "");
    const again = await svc.taskRed(project, "slow", "1");
    expect(again.message).toContain("Red");
    expect(again.ok).toBe(true);
  }, 30_000);
});
