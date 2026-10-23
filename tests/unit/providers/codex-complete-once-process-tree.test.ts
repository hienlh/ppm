import { afterAll, describe, expect, it } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexCompleteOnce, type OneShotRpcClient } from "../../../src/providers/codex-app-server/codex-complete-once.ts";

/**
 * `bun x @openai/codex app-server` is a wrapper that starts the native binary as its own child.
 * This stands in for it with a real wrapper process that starts a real grandchild and, like
 * the wrapper on Windows, passes no signal on to it.
 */
const dir = mkdtempSync(join(tmpdir(), "ppm-codex-tree-"));
const wrapper = join(dir, "wrapper.js");
writeFileSync(wrapper, [
  "const { spawn } = require('node:child_process');",
  "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
  "require('node:fs').writeFileSync(process.argv[2], String(child.pid));",
  "setInterval(() => {}, 1000);",
].join("\n"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The app-server's side of the protocol, spoken by a client whose process is the wrapper. */
class WrapperClient implements OneShotRpcClient {
  private proc: ChildProcess | null = null;
  constructor(private pidFile: string) {}
  get pid() { return this.proc?.pid; }
  start() { this.proc = spawn(process.execPath, [wrapper, this.pidFile], { stdio: ["pipe", "ignore", "ignore"] }); }
  async request<T>(method: string): Promise<T> {
    if (method === "initialize") {
      for (let i = 0; i < 100 && !existsSync(this.pidFile); i++) await sleep(50);
      return {} as T;
    }
    if (method === "thread/start") return { thread: { id: "t1" } } as T;
    if (method === "turn/start") return { turn: { id: "turn-1" } } as T;
    return {} as T;
  }
  notify() {}
  onNotification() {}
  onServerRequest() {}
  onClose() {}
  respondError() {}
  /** What the real client does: end stdin and SIGTERM the process it spawned. */
  close() {
    try { this.proc?.stdin?.end(); } catch { /* gone */ }
    try { this.proc?.kill("SIGTERM"); } catch { /* gone */ }
  }
}

describe("codexCompleteOnce process tree", () => {
  it("a cancelled call leaves no grandchild of the app-server running", async () => {
    const pidFile = join(dir, "grandchild.pid");
    const client = new WrapperClient(pidFile);
    const controller = new AbortController();
    const pending = codexCompleteOnce(
      { prompt: "Q", systemPrompt: "", model: "gpt-6-mini", timeoutMs: 20_000, signal: controller.signal },
      { cwd: dir, createClient: () => client },
    ).catch((e) => e);
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await sleep(50);
    const grandchild = Number(readFileSync(pidFile, "utf8"));
    expect(alive(grandchild)).toBe(true);
    await sleep(50);
    controller.abort();
    expect((await pending).code).toBe("ABORTED");
    try {
      for (let i = 0; i < 50 && alive(grandchild); i++) await sleep(100);
      expect(alive(grandchild)).toBe(false);
    } finally {
      try { process.kill(grandchild, "SIGKILL"); } catch { /* already gone */ }
    }
  }, 30_000);
});
