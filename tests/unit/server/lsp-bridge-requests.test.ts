/**
 * The bridge's stateful half: a request in flight, and what happens when it is withdrawn.
 *
 * Everything else about `ws/lsp.ts` is covered by pure functions (path resolution, URI
 * rewriting). This is the part that only exists while a socket is open — which is where the
 * cancellation had to land, because `$/cancelRequest` is the only thing that takes a request
 * out of a language server's queue and the bridge was the layer that dropped it on the floor.
 */
import { describe, it, expect, beforeEach, afterAll, mock } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configService } from "../../../src/services/config.service.ts";

const PROJECT = mkdtempSync(join(tmpdir(), "ppm-lsp-bridge-"));
mkdirSync(join(PROJECT, "src"), { recursive: true });
writeFileSync(join(PROJECT, "src", "a.ts"), "const a = 1;\n");

/** A language server that answers when told to, and records what it was asked. */
class FakeSession {
  state = "ready";
  readonly asked: Array<{ method: string; signal?: AbortSignal }> = [];
  readonly notified: Array<{ method: string; params: unknown }> = [];
  private settle: ((value: unknown) => void) | null = null;

  request(method: string, _params: unknown, _timeoutMs?: number, signal?: AbortSignal): Promise<unknown> {
    this.asked.push({ method, signal });
    return new Promise((resolve, reject) => {
      this.settle = resolve;
      signal?.addEventListener("abort", () => reject(new Error(`${method} was cancelled`)), { once: true });
    });
  }
  notify(method: string, params: unknown): void {
    this.notified.push({ method, params });
  }
  answer(result: unknown): void {
    this.settle?.(result);
  }
}

let session: FakeSession;

// The project is registered for real rather than mocking `resolve-project.ts`, which most of
// the server's routes import — a stub for it would follow them into every other test file.
const projects = (configService as unknown as { config: { projects: Array<{ name: string; path: string }> } }).config.projects;
const projectsBefore = [...projects];
projects.push({ name: "demo", path: PROJECT });
afterAll(() => {
  projects.length = 0;
  projects.push(...projectsBefore);
});

// The manager is the one thing that would start a real language server. Everything real about
// the module is kept, so `lsp-manager.test.ts` — which imports the class, in this same process
// — still gets the class and not a stub.
const realManager = await import("../../../src/services/lsp/lsp-manager.ts?real");
mock.module("../../../src/services/lsp/lsp-manager.ts", () => ({
  ...realManager,
  lspManager: {
    acquire: async () => ({ session, language: "typescript", key: "ts:/p" }),
    sessionFor: () => session,
    releaseAll: () => {},
    onNotification: () => () => {},
  },
}));

const { lspWebSocket } = await import("../../../src/server/ws/lsp.ts");

/** A socket, and the messages the bridge wrote back to it. */
function socket() {
  const sent: Array<Record<string, unknown>> = [];
  const ws = {
    data: { type: "lsp", projectName: "demo" },
    send: (data: string) => void sent.push(JSON.parse(data)),
    close: () => {},
  };
  lspWebSocket.open(ws);
  lspWebSocket.message(ws, JSON.stringify({ t: "open", path: "src/a.ts", text: "const a = 1;\n", version: 1, clientUri: "inmemory://model/1" }));
  return { ws, sent, ofType: (t: string) => sent.filter((m) => m.t === t) };
}

beforeEach(() => {
  session = new FakeSession();
});

describe("a request in flight", () => {
  it("is withdrawn when the browser cancels it", async () => {
    const s = socket();
    await Bun.sleep(0); // `open` acquires a session asynchronously

    lspWebSocket.message(s.ws, JSON.stringify({ t: "request", id: 7, path: "src/a.ts", method: "textDocument/completion", params: {} }));
    await Bun.sleep(0);
    expect(session.asked[0]?.signal?.aborted).toBe(false);

    lspWebSocket.message(s.ws, JSON.stringify({ t: "cancel", id: 7 }));
    await Bun.sleep(10);

    expect(session.asked[0]?.signal?.aborted).toBe(true);
    // Nothing goes back: Monaco dropped the provider's promise and the browser deleted its
    // pending entry when it sent the cancel, so a reply would name an id that is gone.
    expect(s.ofType("response")).toEqual([]);
    expect(s.ofType("error")).toEqual([]);
  });

  it("still answers a request nobody cancelled", async () => {
    const s = socket();
    await Bun.sleep(0);

    lspWebSocket.message(s.ws, JSON.stringify({ t: "request", id: 8, path: "src/a.ts", method: "textDocument/hover", params: {} }));
    await Bun.sleep(0);
    session.answer({ contents: "hello" });
    await Bun.sleep(10);

    expect(s.ofType("response")).toEqual([{ t: "response", id: 8, result: { contents: "hello" } }]);
  });

  it("is withdrawn when the tab goes away with it still open", async () => {
    // A closed tab is not waiting for anything, and a server working on its questions is in
    // front of the tabs that are still open.
    const s = socket();
    await Bun.sleep(0);

    lspWebSocket.message(s.ws, JSON.stringify({ t: "request", id: 9, path: "src/a.ts", method: "textDocument/completion", params: {} }));
    await Bun.sleep(0);
    lspWebSocket.close(s.ws);
    await Bun.sleep(10);

    expect(session.asked[0]?.signal?.aborted).toBe(true);
    expect(session.notified.map((n) => n.method)).toContain("textDocument/didClose");
  });

  it("cancels only the request it was told to", async () => {
    const s = socket();
    await Bun.sleep(0);

    for (const id of [1, 2]) {
      lspWebSocket.message(s.ws, JSON.stringify({ t: "request", id, path: "src/a.ts", method: "textDocument/completion", params: {} }));
    }
    await Bun.sleep(0);
    lspWebSocket.message(s.ws, JSON.stringify({ t: "cancel", id: 1 }));
    await Bun.sleep(10);

    expect(session.asked.map((a) => a.signal?.aborted)).toEqual([true, false]);
  });

  it("ignores a cancel for a request that already answered", async () => {
    const s = socket();
    await Bun.sleep(0);

    lspWebSocket.message(s.ws, JSON.stringify({ t: "request", id: 5, path: "src/a.ts", method: "textDocument/hover", params: {} }));
    await Bun.sleep(0);
    session.answer(null);
    await Bun.sleep(10);

    expect(() => lspWebSocket.message(s.ws, JSON.stringify({ t: "cancel", id: 5 }))).not.toThrow();
    expect(s.ofType("response")).toHaveLength(1);
  });
});
