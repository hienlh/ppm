/**
 * The registry behind a new chat's warm CLI: which session gets the process, when it is
 * given up, and that a turn only ever takes over a process spawned exactly as it would
 * have spawned one itself.
 */
import { afterEach, describe, expect, it, jest, mock, spyOn } from "bun:test";
import { WarmSpares, spawnFingerprint, type SpareHandlers } from "../../../src/providers/claude-warm-spare.ts";

interface FakeCli {
  close: ReturnType<typeof mock>;
  initializationResult?: () => Promise<unknown>;
  sessionId: string;
  callbacks: SpareHandlers;
  done: ReturnType<typeof mock>;
}

function registry(limits = { idleMs: 1000, claimedMs: 100, max: 2 }) {
  const spawned: FakeCli[] = [];
  const spares = new WarmSpares<FakeCli>(limits);
  const start = (init?: () => Promise<unknown>) => (sessionId: string, callbacks: SpareHandlers) => {
    const done = mock(() => {});
    const cli: FakeCli = { close: mock(() => {}), sessionId, callbacks, done, ...(init && { initializationResult: init }) };
    spawned.push(cli);
    return { query: cli, controller: { push: () => {}, done } };
  };
  return { spares, spawned, start };
}

function handlers(): SpareHandlers & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    canUseTool: async (tool: string) => { log.push(`canUseTool:${tool}`); return { behavior: "allow" }; },
    preToolUse: async (input: { tool_name: string }) => { log.push(`preToolUse:${input.tool_name}`); return {}; },
    fileWrite: async (input: { tool_name: string }) => { log.push(`fileWrite:${input.tool_name}`); return {}; },
    shellCommand: async (input: { tool_name: string }) => { log.push(`shellCommand:${input.tool_name}`); return {}; },
    stderr: (chunk) => { log.push(`stderr:${chunk}`); },
  };
}

afterEach(() => jest.useRealTimers());

describe("WarmSpares", () => {
  it("gives the process to the session created next in its project, and to that session only", () => {
    const { spares, spawned, start } = registry();
    const id = spares.offer("/p", "fp", start());
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.sessionId).toBe(id);

    expect(spares.claim("/other")).toBeUndefined();
    expect(spares.claim("/p")).toBe(id);
    expect(spares.claim("/p")).toBeUndefined();

    const taken = spares.adopt(id, "fp", handlers());
    expect(taken?.query).toBe(spawned[0]!);
    expect(spawned[0]!.close).not.toHaveBeenCalled();
    expect(spares.adopt(id, "fp", handlers())).toBeUndefined();
  });

  it("forwards the CLI's callbacks to the turn that took it, including what it printed before", async () => {
    const { spares, spawned, start } = registry();
    const id = spares.offer("/p", "fp", start());
    const { callbacks } = spawned[0]!;
    callbacks.stderr("booting\n");
    expect(await callbacks.canUseTool("Bash", {})).toMatchObject({ behavior: "deny" });

    const turn = handlers();
    spares.claim("/p");
    spares.adopt(id, "fp", turn);
    callbacks.stderr("ready\n");
    await callbacks.canUseTool("Bash", {});
    await callbacks.preToolUse({ tool_name: "Write" });
    await callbacks.fileWrite({ tool_name: "Edit" });
    await callbacks.shellCommand({ tool_name: "Bash" });
    expect(turn.log).toEqual(["stderr:booting\n", "stderr:ready\n", "canUseTool:Bash", "preToolUse:Write", "fileWrite:Edit", "shellCommand:Bash"]);
  });

  it("closes a spare the turn would not have spawned, and leaves the turn to start cold", () => {
    const { spares, spawned, start } = registry();
    const id = spares.offer("/p", "fp", start());
    spares.claim("/p");
    expect(spares.adopt(id, "another", handlers())).toBeUndefined();
    expect(spawned[0]!.close).toHaveBeenCalledTimes(1);
    expect(spawned[0]!.done).toHaveBeenCalledTimes(1);
    expect(spares.adopt(id, "fp", handlers())).toBeUndefined();
  });

  it("keeps a spare offered again with the same options, and replaces one whose options changed", () => {
    const { spares, spawned, start } = registry();
    const first = spares.offer("/p", "fp", start());
    expect(spares.offer("/p", "fp", start())).toBe(first);
    expect(spawned).toHaveLength(1);

    const second = spares.offer("/p", "fp2", start());
    expect(second).not.toBe(first);
    expect(spawned).toHaveLength(2);
    expect(spawned[0]!.close).toHaveBeenCalledTimes(1);
    expect(spares.claim("/p")).toBe(second);
  });

  it("gives a spare up when nobody claims it, and a claimed one when its message never comes", () => {
    jest.useFakeTimers();
    const { spares, spawned, start } = registry({ idleMs: 1000, claimedMs: 100, max: 2 });
    spares.offer("/p", "fp", start());
    jest.advanceTimersByTime(600);
    spares.offer("/p", "fp", start()); // offered again: the wait starts over
    jest.advanceTimersByTime(600);
    expect(spawned[0]!.close).not.toHaveBeenCalled();
    jest.advanceTimersByTime(400);
    expect(spawned[0]!.close).toHaveBeenCalledTimes(1);
    expect(spares.claim("/p")).toBeUndefined();

    const id = spares.offer("/p", "fp", start());
    expect(spares.claim("/p")).toBe(id);
    jest.advanceTimersByTime(99);
    expect(spawned[1]!.close).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(spawned[1]!.close).toHaveBeenCalledTimes(1);
    expect(spares.adopt(id, "fp", handlers())).toBeUndefined();
  });

  it("keeps at most `max` processes, giving up the oldest unclaimed one first", () => {
    const { spares, spawned, start } = registry({ idleMs: 1000, claimedMs: 1000, max: 2 });
    const a = spares.offer("/a", "fp", start());
    spares.offer("/b", "fp", start());
    expect(spares.claim("/a")).toBe(a);
    spares.offer("/c", "fp", start());
    expect(spawned.map((cli) => cli.close.mock.calls.length)).toEqual([0, 1, 0]);
    expect(spares.adopt(a, "fp", handlers())?.query).toBe(spawned[0]!);
  });

  it("drops a CLI that dies while starting, so nothing adopts a process that is gone", async () => {
    const { spares, spawned, start } = registry();
    spares.offer("/p", "fp", start(() => Promise.reject(new Error("exited with code 1"))));
    await Promise.resolve();
    await Promise.resolve();
    expect(spawned[0]!.close).toHaveBeenCalledTimes(1);
    expect(spares.claim("/p")).toBeUndefined();
  });

  it("closes everything on request", () => {
    const { spares, spawned, start } = registry();
    spares.offer("/a", "fp", start());
    spares.offer("/b", "fp", start());
    spares.closeAll();
    expect(spawned.every((cli) => cli.close.mock.calls.length === 1)).toBe(true);
    expect(spares.claim("/a")).toBeUndefined();
  });

  it("logs why each process it gives up went, and a CLI that failed to start", async () => {
    jest.useFakeTimers();
    const info = spyOn(console, "log").mockImplementation(() => {});
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { spares, start } = registry({ idleMs: 1000, claimedMs: 100, max: 1 });
      const first = spares.offer("/a", "fp", start());
      const second = spares.offer("/a", "other", start());
      const third = spares.offer("/b", "fp", start());
      jest.advanceTimersByTime(1000);
      const closes = info.mock.calls.map((c) => String(c[0]).replace(/ ageMs=\d+$/, ""));
      expect(closes).toEqual([
        `[sdk] warm CLI session=${first} closed reason=replaced`,
        `[sdk] warm CLI session=${second} closed reason=evicted`,
        `[sdk] warm CLI session=${third} closed reason=expired`,
      ]);

      const failing = spares.offer("/c", "fp", start(() => Promise.reject(new Error("exited with code 1"))));
      await Promise.resolve();
      await Promise.resolve();
      expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
        `[sdk] warm CLI session=${failing} for /c failed to start: exited with code 1`,
      ]);
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });
});

describe("spawnFingerprint", () => {
  const options = { cwd: "/p", env: { A: "1", CLAUDE_CODE_OAUTH_TOKEN: "t1" }, model: "m", stderr: () => {} };

  it("ignores the session id, the callbacks and the order keys were written in", () => {
    expect(spawnFingerprint({ ...options, sessionId: "a" }))
      .toBe(spawnFingerprint({ stderr: () => 1, model: "m", env: { CLAUDE_CODE_OAUTH_TOKEN: "t1", A: "1" }, cwd: "/p", sessionId: "b" }));
  });

  it("changes with anything the CLI would start differently with, a rotated token included", () => {
    const base = spawnFingerprint(options);
    expect(spawnFingerprint({ ...options, model: "n" })).not.toBe(base);
    expect(spawnFingerprint({ ...options, env: { ...options.env, CLAUDE_CODE_OAUTH_TOKEN: "t2" } })).not.toBe(base);
    expect(spawnFingerprint({ ...options, resume: "s" })).not.toBe(base);
  });

  it("does not carry the token it was given", () => {
    expect(spawnFingerprint(options)).not.toContain("t1");
  });
});
