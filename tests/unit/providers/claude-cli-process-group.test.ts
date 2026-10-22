import { afterEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as sdk from "@anthropic-ai/claude-agent-sdk";
import type { SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { endProcessGroup, query, spawnCliInOwnGroup } from "../../../src/providers/claude-cli-process-group.ts";

const FAKE_CLI = resolve(import.meta.dir, "../../fixtures/fake-claude-cli.ts");
// Another test file mocks the SDK module, and a mock outlives its file in one `bun test` process.
const sdkIsMocked = typeof (sdk as Record<string, unknown>).createSdkMcpServer !== "function";

const leftovers: number[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const pid of leftovers.splice(0)) try { process.kill(pid, "SIGKILL"); } catch {}
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Running, not a zombie: an orphan's new parent may be slow to reap it (PID 1 in a container never does). */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return false; }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat[stat.lastIndexOf(")") + 2] !== "Z";
  } catch {
    return true; // no /proc (macOS)
  }
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await Bun.sleep(50);
  }
  return check();
}

function pidFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "ppm-cli-group-"));
  dirs.push(dir);
  return join(dir, "pids.json");
}

async function readPids(file: string): Promise<{ member: number; ownSession: number }> {
  expect(await waitFor(() => existsSync(file) && readFileSync(file, "utf8").length > 0, 5000)).toBe(true);
  const pids = JSON.parse(readFileSync(file, "utf8"));
  leftovers.push(pids.member, pids.ownSession);
  return pids;
}

function fakeCli(file: string): SpawnOptions {
  return { command: process.execPath, args: [FAKE_CLI], env: { ...process.env, FAKE_CLI_PIDS: file }, signal: new AbortController().signal };
}

describe.skipIf(process.platform === "win32")("Claude CLI in a process group of its own", () => {
  it("a CLI spawned the SDK's way leaves its MCP server running when it dies", async () => {
    const file = pidFile();
    const cli = spawn(process.execPath, [FAKE_CLI], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, FAKE_CLI_PIDS: file } });
    const { member } = await readPids(file);
    const exited = new Promise((r) => cli.once("exit", r));
    cli.stdin.end();
    await exited;
    await Bun.sleep(500);
    expect(alive(member)).toBe(true);
  });

  it("ends what the CLI left in its group once it exits", async () => {
    const file = pidFile();
    const cli = spawnCliInOwnGroup(fakeCli(file));
    const { member } = await readPids(file);
    cli.stdin.end();
    expect(await waitFor(() => !alive(member), 3000)).toBe(true);
  });

  it("leaves alone what the CLI started in a session of its own, as it does the Bash tool's commands", async () => {
    const file = pidFile();
    const cli = spawnCliInOwnGroup(fakeCli(file));
    const { member, ownSession } = await readPids(file);
    cli.stdin.end();
    expect(await waitFor(() => !alive(member), 3000)).toBe(true);
    await Bun.sleep(200);
    expect(alive(ownSession)).toBe(true);
  });

  it("SIGKILLs what ignores SIGTERM once the grace is over", async () => {
    const stubborn = spawn("sh", ["-c", "trap '' TERM; echo ready; exec sleep 300"], { stdio: ["ignore", "pipe", "ignore"], detached: true });
    leftovers.push(stubborn.pid!);
    let signal: string | null | undefined;
    const exited = new Promise<void>((r) => stubborn.once("exit", (_code, s) => { signal = s; r(); }));
    await new Promise((r) => stubborn.stdout.once("data", r));

    endProcessGroup(stubborn.pid!, 300);
    await Bun.sleep(150);
    expect(signal).toBeUndefined();
    await exited;
    expect(signal).toBe("SIGKILL");
  });

  it("hands stderr to the callback before it delivers the exit", async () => {
    let stderr = "";
    // The end of stderr comes after the exit: a child still holding it writes 100 ms later.
    const cli = spawnCliInOwnGroup(
      { command: "sh", args: ["-c", "echo boom >&2; (trap '' TERM; sleep 0.1; echo late >&2) & exit 3"], env: { ...process.env }, signal: new AbortController().signal },
      (text) => { stderr += text; },
    );
    const [code, seen] = await new Promise<[number | null, string]>((r) => cli.on("exit", (c) => r([c, stderr])));
    expect(code).toBe(3);
    expect(seen).toBe("boom\nlate\n");
  });

  it.skipIf(sdkIsMocked)("query() closed takes the CLI's MCP server with it", async () => {
    const file = pidFile();
    async function* idle(): AsyncGenerator<never> { await new Promise(() => {}); }
    const q = query({
      prompt: idle(),
      options: { pathToClaudeCodeExecutable: FAKE_CLI, executable: process.execPath as "bun", env: { ...process.env, FAKE_CLI_PIDS: file } },
    });
    const drained = (async () => { try { for await (const _ of q) {} } catch {} })();
    const { member, ownSession } = await readPids(file);
    q.close();
    expect(await waitFor(() => !alive(member), 5000)).toBe(true);
    expect(alive(ownSession)).toBe(true);
    await drained;
  });
});
