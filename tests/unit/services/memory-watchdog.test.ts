import { describe, it, expect } from "bun:test";
import { descendantsOf, parseLinuxStatLine, parseWindowsProcessList, readProcessList, type ProcessMemoryEntry } from "../../../src/services/process-tree-memory.ts";
import { SpawnTracker, sessionOf, type ChildLifecycleEvent } from "../../../src/services/memory-diagnostics-spawns.ts";
import { RequestTracker, diffRequestCounts, requestRouteKey } from "../../../src/services/memory-diagnostics-requests.ts";
import { describeTree, summarizeDescendants } from "../../../src/services/memory-watchdog.ts";

const proc = (pid: number, ppid: number, name: string, privateMB: number, startedAt: number): ProcessMemoryEntry =>
  ({ pid, ppid, name, privateMB, startedAt });

describe("descendantsOf", () => {
  it("walks the whole tree and remembers which direct child each process hangs under", () => {
    const list = [
      proc(1, 0, "bun", 500, 100),
      proc(2, 1, "claude", 600, 200),
      proc(3, 2, "uv", 40, 300),
      proc(4, 3, "python", 50, 400),
      proc(5, 1, "git", 10, 250),
      proc(6, 99, "other", 900, 50),
    ];
    const d = descendantsOf(1, list);
    expect(d.map((x) => x.pid).sort()).toEqual([2, 3, 4, 5]);
    expect(d.find((x) => x.pid === 4)).toMatchObject({ depth: 3, branchPid: 2 });
  });

  it("does not claim a process whose parent pid was reused by an older, unrelated process", () => {
    // pid 7 started before the root, so it cannot be the root's child even though ppid says so.
    const list = [proc(1, 0, "bun", 500, 100), proc(7, 1, "orphan", 3000, 50), proc(8, 7, "grandorphan", 10, 60)];
    expect(descendantsOf(1, list)).toEqual([]);
  });

  it("survives a ppid cycle", () => {
    const list = [proc(1, 0, "bun", 1, 1), proc(2, 1, "a", 1, 2), proc(3, 2, "b", 1, 3), proc(2, 3, "a", 1, 2)];
    expect(descendantsOf(1, list).length).toBeLessThanOrEqual(3);
  });
});

describe("parseWindowsProcessList", () => {
  it("reads pid, parent, image name, private bytes and start time from a SystemProcessInformation buffer", () => {
    const size = 0x100;
    const name = "Claude.EXE";
    const nameBytes = new Uint8Array(new TextEncoder().encode(name).length * 2);
    for (let i = 0; i < name.length; i++) nameBytes[i * 2] = name.charCodeAt(i);
    const buf = new ArrayBuffer(size * 2 + nameBytes.length);
    const view = new DataView(buf);
    const base = 0x10000n;
    const write = (at: number, pid: number, ppid: number, privateBytes: bigint, next: number, withName: boolean) => {
      view.setUint32(at + 0x00, next, true);
      // 2026-10-26T00:00:00Z as FILETIME ticks.
      view.setBigInt64(at + 0x20, BigInt(Date.UTC(2026, 9, 26)) * 10_000n + 116_444_736_000_000_000n, true);
      if (withName) {
        view.setUint16(at + 0x38, nameBytes.length, true);
        view.setBigUint64(at + 0x40, base + BigInt(size * 2), true);
      }
      view.setBigUint64(at + 0x50, BigInt(pid), true);
      view.setBigUint64(at + 0x58, BigInt(ppid), true);
      view.setBigUint64(at + 0xc8, privateBytes, true);
    };
    write(0, 0, 0, 0n, size, false);
    write(size, 4242, 61120, 683n * 1024n * 1024n, 0, true);
    new Uint8Array(buf, size * 2).set(nameBytes);

    const list = parseWindowsProcessList(view, base);
    expect(list).toHaveLength(2);
    expect(list[0]!.name).toBe("idle");
    expect(list[1]).toEqual({ pid: 4242, ppid: 61120, name: "claude", privateMB: 683, startedAt: Date.UTC(2026, 9, 26) });
  });

  it("reads this machine for real and finds the test runner itself", async () => {
    const list = await readProcessList();
    if (process.platform !== "win32" && process.platform !== "linux") return expect(list).toBeNull();
    expect(list!.some((p) => p.pid === process.pid && p.privateMB > 0)).toBe(true);
  });
});

describe("parseLinuxStatLine", () => {
  it("reads ppid and start time past a command name holding spaces and parentheses", () => {
    const line = "4242 (Web Content (x)) S 61120 4242 4242 0 -1 4194560 1 0 0 0 5 3 0 0 20 0 30 0 987654 0 0";
    expect(parseLinuxStatLine(line)).toEqual({ ppid: 61120, name: "web content (x)", startedAt: 987654 });
  });
});

describe("spawn tracker sessions and lifecycle", () => {
  it("takes the session a Claude subprocess resumes, in either spelling, and nothing that is not a UUID", () => {
    const id = "48008560-faff-4a3e-aa6f-bef1eebc82b4";
    expect(sessionOf(["claude.exe", "--output-format", "stream-json", `--resume=${id}`])).toBe(id);
    expect(sessionOf(["claude.exe", "--session-id", id])).toBe(id);
    expect(sessionOf(["claude.exe", "--resume", "sk-not-a-session"])).toBeUndefined();
    expect(sessionOf(["git", "status"])).toBeUndefined();
  });

  it("reports a Claude child's start and its exit with age and last reading, and stays quiet about git", async () => {
    let now = 0;
    const tracker = new SpawnTracker(() => now);
    const events: ChildLifecycleEvent[] = [];
    tracker.onLifecycle = (e) => events.push(e);

    let exitClaude!: () => void;
    const claude = { pid: 10, exited: new Promise<void>((r) => { exitClaude = r; }) };
    tracker.record("claude", claude, "48008560-faff-4a3e-aa6f-bef1eebc82b4");
    tracker.record("git status", { pid: 11, exited: Promise.resolve() });
    tracker.describe(10)!.lastPrivateMB = 650;
    now = 95 * 60_000;
    exitClaude();
    await claude.exited;
    await Promise.resolve();

    expect(events).toEqual([
      { event: "start", pid: 10, label: "claude", session: "48008560-faff-4a3e-aa6f-bef1eebc82b4" },
      { event: "exit", pid: 10, label: "claude", session: "48008560-faff-4a3e-aa6f-bef1eebc82b4", ageMin: 95, lastPrivateMB: 650 },
    ]);
    expect(tracker.describe(10)).toBeUndefined();
  });

  it("sees a child started through node:child_process, the path the Claude SDK takes", async () => {
    const tracker = new SpawnTracker();
    const events: ChildLifecycleEvent[] = [];
    tracker.onLifecycle = (e) => events.push(e);
    const bun = Bun as unknown as Record<"spawn" | "spawnSync", unknown>;
    const original = { spawn: bun.spawn, spawnSync: bun.spawnSync };
    tracker.install();
    try {
      const { spawn } = await import("node:child_process");
      const child = spawn(process.execPath, ["--version"]);
      await new Promise((r) => child.once("exit", r));
    } finally {
      bun.spawn = original.spawn;
      bun.spawnSync = original.spawnSync;
    }
    expect(tracker.topTotals(5)).toHaveProperty("bun");
  });
});

describe("request tracking", () => {
  it("keeps route words and drops names, ids, paths and tokens", () => {
    expect(requestRouteKey("GET", "/api/project/my-secret-project/files/raw")).toBe("GET /api/project/:name/files");
    expect(requestRouteKey("GET", "/api/html-preview/content/abcDEF123token/index.html")).toBe("GET /api/html-preview/content/:name");
    expect(requestRouteKey("POST", "/api/chat/48008560-faff-4a3e-aa6f-bef1eebc82b4/send")).toBe("POST /api/chat/:x/send");
    expect(requestRouteKey("GET", "/assets/index-AbC123.js")).toBe("GET static .js");
    expect(requestRouteKey("GET", "/project/x/editor/src/main.tsx")).toBe("GET static .tsx");
  });

  it("diffs two readings into the busiest routes with the bytes they sent", () => {
    const t = new RequestTracker();
    t.record("GET", "/api/project/a/files/raw", String(2 * 1024 * 1024));
    const first = t.read();
    t.record("GET", "/api/project/a/files/raw", String(3 * 1024 * 1024));
    t.record("GET", "/api/project/b/files/raw", null);
    t.record("GET", "/api/health", "2");
    const d = diffRequestCounts(first, t.read(), 5);
    expect(d.total).toBe(3);
    expect(d.top["GET /api/project/:name/files"]).toEqual({ n: 2, mb: 3, streamed: 1 });
    expect(Object.keys(d.top)[0]).toBe("GET /api/project/:name/files");
  });
});

describe("watchdog summary", () => {
  it("names the biggest branches by chat session and folds the rest by program", () => {
    const text = describeTree({
      count: 4,
      privateMB: 1900,
      byName: { claude: { n: 2, mb: 1300 }, python: { n: 2, mb: 600 } },
      branches: [
        { pid: 39788, name: "claude", label: "claude", session: "48008560-faff-4a3e-aa6f-bef1eebc82b4", ageMin: 30, ownMB: 683, treeMB: 1283 },
        { pid: 47256, name: "claude", label: "claude", ownMB: 605, treeMB: 605 },
      ],
    });
    expect(text).toBe(
      "children 4 = 1900MB [claude ×2 1300MB, python ×2 600MB] biggest: "
      + "claude pid=39788 session=48008560 30m 1283MB (own 683MB); claude pid=47256 claude 605MB",
    );
    expect(describeTree(undefined)).toBe("children unreadable");
  });

  it("summarises this process's real children", async () => {
    const child = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 5000)"]);
    try {
      const tree = await summarizeDescendants(process.pid, 5);
      if (process.platform !== "win32" && process.platform !== "linux") return expect(tree).toBeUndefined();
      expect(tree!.branches.some((b) => b.pid === child.pid)).toBe(true);
    } finally {
      child.kill();
    }
  });
});
