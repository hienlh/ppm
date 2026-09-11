/**
 * The session against a real child process speaking real framing.
 *
 * Everything here is a failure mode that was cheap to get wrong and expensive
 * to notice: a request that never settles, a server that stalls waiting for a
 * configuration answer, a crash mid-session, and a leaked process.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { resolve } from "node:path";
import { LspSession } from "../../../../src/services/lsp/lsp-session.ts";
import type { LanguageServerDefinition } from "../../../../src/services/lsp/server-registry.ts";

const FIXTURE = resolve(import.meta.dir, "../../../fixtures/fake-language-server.ts");

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
});
