/**
 * The Run button on a chat's shell code block: the command runs in the project folder and the
 * route answers what it printed and how it ended. Closing the request stops it (the Stop button),
 * every process under it included, and the AI-chat mark of the server never reaches it.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

process.env.PPM_HOME ??= mkdtempSync(join(tmpdir(), "ppm-code-block-run-home-"));
const { codeBlockRunRoutes } = await import("../../../src/server/routes/code-block-run.ts");

const project = mkdtempSync(join(tmpdir(), "ppm-code-block-run-proj-"));
writeFileSync(join(project, ".env"), "PORT=1\nMASTER_PASSWORD=hunter2\n");
afterAll(() => rmSync(project, { recursive: true, force: true }));

const app = new Hono<{ Variables: { projectPath: string; projectName: string } }>();
app.use("*", async (c, next) => { c.set("projectPath", project); c.set("projectName", "p"); await next(); });
app.route("/shell", codeBlockRunRoutes);

const post = (body: unknown, init: RequestInit = {}) =>
  app.request("/shell/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), ...init });

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe.skipIf(process.platform === "win32")("POST /shell/run", () => {
  it("runs the block in the project folder and answers its output and exit code", async () => {
    const res = await post({ command: "grep '^MASTER_PASSWORD=' .env && pwd" });
    const json = await res.json() as { ok: boolean; data: { output: string; exitCode: number } };
    expect(json.ok).toBe(true);
    expect(json.data.exitCode).toBe(0);
    expect(json.data.output).toContain("MASTER_PASSWORD=hunter2");
    expect(json.data.output).toContain(project);
  });

  it("reports a failing command's exit code and its stderr", async () => {
    const json = await (await post({ command: "echo oops >&2; exit 3" })).json() as { data: { output: string; exitCode: number } };
    expect(json.data.exitCode).toBe(3);
    expect(json.data.output).toContain("oops");
  });

  it("does not pass the server's AI-chat mark on", async () => {
    const before = process.env.PPM_AI_CHAT;
    process.env.PPM_AI_CHAT = "1";
    try {
      const json = await (await post({ command: "echo mark=[$PPM_AI_CHAT]" })).json() as { data: { output: string } };
      expect(json.data.output).toContain("mark=[]");
    } finally {
      if (before === undefined) delete process.env.PPM_AI_CHAT; else process.env.PPM_AI_CHAT = before;
    }
  });

  it("refuses an empty or oversized command", async () => {
    expect((await post({ command: "   " })).status).toBe(400);
    expect((await post({ command: "x".repeat(16_001) })).status).toBe(400);
    expect((await post({})).status).toBe(400);
  });

  it("stops the run, grandchildren included, when the request is closed", async () => {
    const ctl = new AbortController();
    const pending = post({ command: "sh -c 'sleep 60 & echo $! > grandchild.pid; wait'" }, { signal: ctl.signal }).catch(() => null);
    const pidFile = join(project, "grandchild.pid");
    const end = Date.now() + 5_000;
    while (!(existsSync(pidFile) && readFileSync(pidFile, "utf8").trim())) {
      if (Date.now() > end) throw new Error("the command never started");
      await Bun.sleep(25);
    }
    const grandchild = Number(readFileSync(pidFile, "utf8"));
    expect(alive(grandchild)).toBe(true);
    ctl.abort();
    await pending;
    const gone = Date.now() + 5_000;
    while (alive(grandchild)) {
      if (Date.now() > gone) throw new Error("the run kept going after its request closed");
      await Bun.sleep(25);
    }
  }, 20_000);
});
