import { describe, expect, it } from "bun:test";
import {
  decideHeavyGate, HeavyCommandGate, HEAVY_QUEUE_WAIT_MS, isHeavyCommand, isHeavyProcess, parseCommandLines, type ProcLine,
} from "../../../src/services/memory-guard/heavy-command-gate.ts";
import { buildToolHooks, preToolUseDecision } from "../../../src/providers/claude-agent-sdk-query-options.ts";

describe("what counts as heavy", () => {
  it("knows the commands chats run to test, type-check, build and run e2e", () => {
    for (const c of [
      // The command that took the machine down on 20/11/2026.
      "$env:NODE_OPTIONS='--max-old-space-size=8192'; node node_modules/jest/bin/jest.js --forceExit --maxWorkers=2 $specs",
      "npx tsc --noEmit", "bun test tests/unit", "pnpm run test", "npm test", "yarn build", "vite build",
      "npx playwright test", "docker run --rm ppm-e2e-chromium", "docker compose up -d", "cargo test", "pytest -q",
    ]) expect([c, isHeavyCommand(c)]).toEqual([c, true]);
    for (const c of ["git status", "ls node_modules", "cat tsconfig.json", "npx -y @playwright/mcp@latest", "docker ps -a", "bun run dev:server"]) {
      expect([c, isHeavyCommand(c)]).toEqual([c, false]);
    }
  });

  it("knows a running heavy job, and not an MCP server or a watcher", () => {
    expect(isHeavyProcess('"node" D:\\x\\node_modules\\jest\\bin\\jest.js --maxWorkers=2')).toBe(true);
    expect(isHeavyProcess("node /repo/node_modules/jest-worker/build/workers/processChild.js")).toBe(true);
    expect(isHeavyProcess("node /repo/node_modules/typescript/bin/tsc --noEmit")).toBe(true);
    expect(isHeavyProcess("C:\\Users\\PC\\.bun\\bin\\bun.exe test tests/unit")).toBe(true);
    expect(isHeavyProcess('"node" C:\\npm-cache\\_npx\\x\\node_modules\\@playwright\\mcp\\cli.js --extension')).toBe(false);
    expect(isHeavyProcess("node node_modules/vitest/vitest.mjs --watch")).toBe(false);
    expect(isHeavyProcess("bun run src/server/index.ts __serve__ 0")).toBe(false);
  });
});

describe("decideHeavyGate", () => {
  const base = { command: "npx jest", freeMB: 30_000, blockGB: 10, running: [] as ProcLine[], leased: false, waitedMs: 0 };

  it("lets anything not heavy through, whatever memory says", () => {
    expect(decideHeavyGate({ ...base, command: "git log", freeMB: 100 })).toEqual({ action: "allow" });
  });

  it("refuses a heavy command under the block threshold, with what to do about it", () => {
    const v = decideHeavyGate({ ...base, freeMB: 4500 });
    expect(v.action).toBe("deny");
    expect(v.action === "deny" && v.reason).toContain("only 4.4 GB of memory free (under 10 GB)");
    expect(v.action === "deny" && v.reason).toContain("--maxWorkers=1");
    expect(decideHeavyGate({ ...base, freeMB: 4500, blockGB: 0 })).toEqual({ action: "allow" });
    expect(decideHeavyGate({ ...base, freeMB: null })).toEqual({ action: "allow" });
  });

  it("waits behind a running heavy job or a fresh lease, then refuses naming it", () => {
    const running = [{ pid: 7, cmdline: "node jest.js" }];
    expect(decideHeavyGate({ ...base, running })).toEqual({ action: "wait", running });
    expect(decideHeavyGate({ ...base, leased: true })).toEqual({ action: "wait", running: [] });
    const v = decideHeavyGate({ ...base, running, waitedMs: HEAVY_QUEUE_WAIT_MS });
    expect(v.action === "deny" && v.reason).toContain("pid 7: node jest.js is still running after 5 min");
  });
});

describe("HeavyCommandGate", () => {
  it("queues one heavy command behind another and lets it go when the first finishes", async () => {
    let now = 0;
    let running: ProcLine[] = [{ pid: 7, cmdline: "node /r/node_modules/jest/bin/jest.js" }];
    const gate = new HeavyCommandGate({
      readFreeMB: async () => 30_000,
      blockGB: () => 10,
      listRunning: async () => running,
      sleep: async (ms) => { now += ms; if (now >= 30_000) running = []; },
      now: () => now,
    });
    expect(await gate.check("npx jest a.spec.ts")).toBeNull();
    expect(now).toBe(30_000);
    // The lease: a second heavy command right after waits while the first one's processes come up,
    // and goes once the lease has run out with nothing heavy seen running.
    expect(await gate.check("npx tsc --noEmit")).toBeNull();
    expect(now).toBe(30_000 + 90_000);
  });

  it("never holds a light command", async () => {
    const gate = new HeavyCommandGate({
      readFreeMB: async () => 1, blockGB: () => 10, listRunning: async () => [], sleep: async () => {}, now: () => 0,
    });
    expect(await gate.check("git status")).toBeNull();
  });
});

describe("parseCommandLines", () => {
  it("reads PowerShell tab lines and ps lines", () => {
    expect(parseCommandLines("12\tnode a.js\r\nbad\n34\tbun test\n", "\t")).toEqual([{ pid: 12, cmdline: "node a.js" }, { pid: 34, cmdline: "bun test" }]);
    expect(parseCommandLines("  12 node a.js\n 345 /bin/zsh -l\n", null)).toEqual([{ pid: 12, cmdline: "node a.js" }, { pid: 345, cmdline: "/bin/zsh -l" }]);
  });
});

describe("buildToolHooks with the gate", () => {
  const bash = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "npx jest" } };
  const deny = async () => preToolUseDecision("deny", "held");
  const log: string[] = [];
  const shell = async () => { log.push("shell"); return {}; };
  const noop = async () => ({});

  it("refuses before the shell capture runs, in bypass mode and after the permission check otherwise", async () => {
    for (const isBypass of [true, false]) {
      log.length = 0;
      const hooks = buildToolHooks({ isBypass, preToolUse: async () => preToolUseDecision("allow"), fileWrite: noop, shellCommand: shell, heavyGate: deny }) as any;
      const entry = hooks.PreToolUse.find((e: any) => isBypass ? e.matcher === "Bash|PowerShell" : e.matcher === ".*");
      const verdict = await entry.hooks[0](bash);
      expect(verdict.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(verdict.hookSpecificOutput.permissionDecisionReason).toBe("held");
      expect(log).toEqual([]);
      if (isBypass) expect(entry.timeout).toBe(600);
    }
  });

  it("is the same as before without a gate", async () => {
    log.length = 0;
    const hooks = buildToolHooks({ isBypass: true, preToolUse: noop, fileWrite: noop, shellCommand: shell }) as any;
    await hooks.PreToolUse[1].hooks[0](bash);
    expect(log).toEqual(["shell"]);
    expect(hooks.PreToolUse[1].timeout).toBeUndefined();
  });
});
