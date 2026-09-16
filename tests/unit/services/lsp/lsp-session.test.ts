/**
 * The session against a real child process speaking real framing.
 *
 * Everything here is a failure mode that was cheap to get wrong and expensive
 * to notice: a request that never settles, a server that stalls waiting for a
 * configuration answer, a crash mid-session, and a leaked process.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { resolve } from "node:path";
import { LspSession, stopServerProcess } from "../../../../src/services/lsp/lsp-session.ts";
import type { LanguageServerDefinition } from "../../../../src/services/lsp/server-registry.ts";

const FIXTURE = resolve(import.meta.dir, "../../../fixtures/fake-language-server.ts");
/** `SHUTDOWN_GRACE_MS` in `lsp-session.ts`; not exported, and not worth exporting for this. */
const SHUTDOWN_GRACE_MS = 3_000;

function definition(): LanguageServerDefinition {
  return {
    id: "fake",
    displayName: "Fake",
    languages: ["plaintext"],
    command: "bun",
    args: [FIXTURE],
    rootMarkers: [],
    installHint: "it is a fixture; it does not install",
  };
}

const open: LspSession[] = [];

async function start(mode?: string, overrides: Partial<Parameters<typeof LspSession.start>[0]> = {}): Promise<LspSession> {
  if (mode) process.env.FAKE_LSP_MODE = mode;
  else delete process.env.FAKE_LSP_MODE;
  const session = await LspSession.start({
    definition: definition(),
    commandPath: "bun",
    rootPath: import.meta.dir,
    ...overrides,
  });
  open.push(session);
  return session;
}

afterEach(async () => {
  delete process.env.FAKE_LSP_MODE;
  await Promise.all(open.splice(0).map((s) => s.dispose()));
});

describe("LspSession.start", () => {
  it("completes the handshake and keeps what the server said it can do", async () => {
    const session = await start();

    expect(session.state).toBe("ready");
    expect(session.serverCapabilities.hoverProvider).toBe(true);
    expect((session.initializeResult?.serverInfo as { name: string }).name).toBe("fake-language-server");
  });

  it("reports a command that does not exist, with the install hint", async () => {
    await expect(
      LspSession.start({
        definition: definition(),
        commandPath: "/nonexistent/definitely-not-a-language-server",
        rootPath: import.meta.dir,
      }),
    ).rejects.toThrow(/it is a fixture/);
  });
});

describe("LspSession.request", () => {
  it("round-trips params and result", async () => {
    const session = await start();

    const result = await session.request("fake/echo", { hello: "world" });

    expect(result).toMatchObject({ echoed: { hello: "world" } });
  });

  it("keeps a multi-byte payload intact across the pipe", async () => {
    const session = await start();

    const result = (await session.request("fake/unicode", null)) as { text: string };

    expect(result.text).toBe("Chào bạn — “quotes” 🎉");
  });

  it("survives many concurrent requests without crossing the answers", async () => {
    const session = await start();

    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => session.request("fake/echo", { i })),
    );

    expect(results.map((r) => (r as { echoed: { i: number } }).echoed.i)).toEqual(
      Array.from({ length: 30 }, (_, i) => i),
    );
  });

  it("turns a server error response into a rejection", async () => {
    const session = await start();

    await expect(session.request("fake/error", null)).rejects.toThrow(/invalid params, as requested/);
  });

  it("rejects an unknown method rather than hanging", async () => {
    const session = await start();

    await expect(session.request("fake/nothing", null)).rejects.toThrow(/Method not found/);
  });

  it("times out instead of leaving the caller waiting forever", async () => {
    // A Monaco provider awaits this promise; one that never settles leaves the
    // suggest widget spinning with no way back.
    const session = await start("hang");

    await expect(session.request("fake/echo", null, 250)).rejects.toThrow(/did not answer fake\/echo within 250ms/);
  });

  it("withdraws a cancelled request from the server's queue", async () => {
    // A language server answers one request at a time, so a superseded completion is not
    // free — it sits in front of the one the user is waiting for. `$/cancelRequest` is the
    // only thing that takes it out, and until this existed it was sent on timeout alone.
    const session = await start("hang");
    const controller = new AbortController();

    const inflight = session.request("fake/echo", { a: 1 }, 20_000, controller.signal);
    await Bun.sleep(40);
    controller.abort();

    await expect(inflight).rejects.toThrow(/fake\/echo was cancelled/);
    const reported = (await session.request("fake/cancelled", null)) as { cancelled: number[] };
    // The `initialize` request is id 1, so the cancelled one is id 2.
    expect(reported.cancelled).toEqual([2]);
  });

  it("refuses a request that is cancelled before it is sent", async () => {
    const session = await start();
    const controller = new AbortController();
    controller.abort();

    await expect(session.request("fake/echo", null, 20_000, controller.signal)).rejects.toThrow(/was cancelled/);
    // Nothing to withdraw: it was never in the queue.
    const reported = (await session.request("fake/cancelled", null)) as { cancelled: number[] };
    expect(reported.cancelled).toEqual([]);
  });

  it("does not withdraw a request that answered normally", async () => {
    const session = await start();
    const controller = new AbortController();

    await session.request("fake/echo", { a: 1 }, 20_000, controller.signal);
    controller.abort(); // the caller lost interest after the answer arrived

    const reported = (await session.request("fake/cancelled", null)) as { cancelled: number[] };
    expect(reported.cancelled).toEqual([]);
  });

  it("refuses a request once the session is disposed", async () => {
    const session = await start();
    await session.dispose();

    await expect(session.request("fake/echo", null)).rejects.toThrow(/is not running/);
  });
});

describe("server-initiated messages", () => {
  it("answers workspace/configuration unprompted, so the server does not stall", async () => {
    // A real server will not serve a single completion until it hears back.
    const session = await start("needs-config");

    const result = (await session.request("fake/echo", { x: 1 })) as { configAnswered: boolean };

    expect(result.configAnswered).toBe(true);
  });

  it("forwards a request it does not handle itself", async () => {
    const seen: string[] = [];
    const session = await start(undefined, {
      onServerRequest: async (method) => {
        seen.push(method);
        return { ok: true };
      },
    });

    await session.request("fake/serverRequest", null);
    // The forwarded request is answered out of band; give the round trip a tick.
    await Bun.sleep(80);

    expect(seen).toContain("fake/askClient");
  });

  it("delivers notifications to the listener", async () => {
    const notifications: string[] = [];
    await start(undefined, { onNotification: (method) => notifications.push(method) });
    await Bun.sleep(120);

    expect(notifications).toContain("window/logMessage");
  });
});

describe("failure and cleanup", () => {
  it("reports a crash and fails the requests that were in flight", async () => {
    const exits: Array<{ code: number | null; state: string }> = [];
    const session = await start("crash", { onExit: (info) => exits.push(info) });

    await Bun.sleep(300);

    expect(session.state).toBe("crashed");
    expect(exits[0]?.code).toBe(3);
    await expect(session.request("fake/echo", null)).rejects.toThrow(/is not running/);
  });

  it("fails the session when the server writes something that is not framing", async () => {
    // A crash trace on stdout desynchronises the stream permanently; there is
    // no way to resynchronise, so the session must not pretend otherwise.
    const session = await start("garbage");

    await Bun.sleep(300);

    expect(session.state).toBe("crashed");
  });

  it("leaves no process behind after dispose", async () => {
    const session = await start();
    const pid = (session as unknown as { proc: { pid: number } }).proc.pid;

    await session.dispose();

    expect(session.state).toBe("stopped");
    // A leaked rust-analyzer holds a whole crate graph in memory for the life
    // of PPM, on machines where that is the whole machine.
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("is safe to dispose twice", async () => {
    const session = await start();

    await session.dispose();
    await session.dispose();

    expect(session.state).toBe("stopped");
  });

  it("sends shutdown before exit, so the server can flush what it caches", async () => {
    // The fixture exits by the specification's own rule — 0 when `shutdown` arrived first,
    // 1 when only `exit` did — which is the one thing a client can observe from outside.
    // `dispose()` used to set the state to `stopped` before asking, and `request()` refuses
    // to send on a stopped session, so `shutdown` was rejected before it was ever written
    // and rust-analyzer and gopls never got the chance the comment on `dispose()` promises.
    const exits: Array<{ code: number | null; state: string }> = [];
    const session = await start(undefined, { onExit: (info) => exits.push(info) });

    await session.dispose();
    await Bun.sleep(60);

    expect(exits[0]?.code).toBe(0);
  });

  it("calls a clean shutdown stopped, not crashed", async () => {
    // The process exits while `dispose()` is still in its handshake, so whoever wins that
    // race decides what `onExit` reports — and a crash notice on every idle shutdown would
    // reach the Problems panel through the bridge.
    const exits: Array<{ code: number | null; state: string }> = [];
    const session = await start(undefined, { onExit: (info) => exits.push(info) });

    await session.dispose();
    await Bun.sleep(60);

    expect(exits[0]?.state).toBe("stopped");
    expect(session.state).toBe("stopped");
  });

  it("gives up on a server that answers neither shutdown nor exit, in one grace period", async () => {
    const session = await start("deaf-shutdown");
    const pid = (session as unknown as { proc: { pid: number } }).proc.pid;

    const started = Date.now();
    await session.dispose();
    const elapsed = Date.now() - started;

    expect(session.state).toBe("stopped");
    await Bun.sleep(250); // the signal is delivered asynchronously
    expect(() => process.kill(pid, 0)).toThrow();
    // One budget for the whole handshake, not one per step: waiting the full grace for
    // `shutdown` and then again for the exit holds up PPM's own shutdown for twice as long,
    // per hung server, in `disposeAll()`.
    expect(elapsed).toBeLessThan(SHUTDOWN_GRACE_MS + 1_200);
  });

  it("calls a server that quits on shutdown stopped, not crashed", async () => {
    // Some servers treat `shutdown` as "quit now" and go without replying, so the process is
    // gone while `dispose()` is still in its handshake. Reporting that as a crash puts an
    // error in front of someone who only closed a tab — the bridge forwards it to the
    // browser, and the manager drops the entry either way.
    const exits: Array<{ code: number | null; state: string }> = [];
    const session = await start("quits-on-shutdown", { onExit: (info) => exits.push(info) });

    await session.dispose();
    await Bun.sleep(60);

    expect(exits[0]?.state).toBe("stopped");
    expect(session.state).toBe("stopped");
  });
});

describe("stopServerProcess", () => {
  /** A process that records what was done to it, standing in for `Bun.spawn`'s. */
  function fake(exitCode: number | null = null) {
    const calls: string[] = [];
    const killedTrees: number[] = [];
    const proc = { pid: 4242, exitCode, kill: () => calls.push("kill") };
    return { proc, calls, killedTrees, killTree: (pid: number) => killedTrees.push(pid) };
  }

  it("signals the process directly off Windows", () => {
    // Measured on Linux: the SIGTERM from `proc.kill()` reached all three `tsserver`
    // children `typescript-language-server` forks, and all three exited. A tree kill here
    // would be SIGKILL, taking away the flush the handshake just bought.
    const f = fake();

    stopServerProcess(f.proc, "linux", f.killTree);

    expect(f.calls).toEqual(["kill"]);
    expect(f.killedTrees).toEqual([]);
  });

  it("kills the whole tree on Windows, because the process PPM holds is a shim", () => {
    // `server-registry.ts` prefers `node_modules/.bin/<server>.cmd`, and Windows runs a
    // `.cmd` through `cmd.exe` — so terminating what Bun handed back leaves the real
    // `node.exe`, and every `tsserver` under it, resident for the life of the machine.
    const f = fake();

    stopServerProcess(f.proc, "win32", f.killTree);

    expect(f.killedTrees).toEqual([4242]);
    expect(f.calls).toEqual([]);
  });

  it("leaves an already-reaped pid alone on both platforms", () => {
    // Windows recycles pids aggressively, and `taskkill /T` on one that now belongs to
    // something else takes that whole tree with it.
    for (const platform of ["win32", "linux"] as const) {
      const f = fake(0);
      stopServerProcess(f.proc, platform, f.killTree);
      expect(f.calls).toEqual([]);
      expect(f.killedTrees).toEqual([]);
    }
  });

  it("is the only thing in lsp-session.ts that terminates a process", () => {
    // A bare `proc.kill()` added later would leak on Windows exactly as before, and look
    // completely ordinary in review.
    const src = require("node:fs").readFileSync(
      resolve(import.meta.dir, "../../../../src/services/lsp/lsp-session.ts"),
      "utf8",
    );
    const body = src.slice(src.indexOf("export class LspSession"));
    expect(body).not.toMatch(/proc\??\.kill\(\)/);
  });
});
