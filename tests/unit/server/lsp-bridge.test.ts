/**
 * The bridge's stateful half — everything about `ws/lsp.ts` that only exists while a socket
 * is open. The pure halves (path resolution, URI rewriting) are covered next door.
 *
 * Four behaviours live here and each one fails silently when it breaks, which is why they are
 * worth the harness: a request in flight and its withdrawal; the version check that asks the
 * browser to resend a document rather than let the server's copy drift; the hold that may only
 * be given up when the socket's *last* document on a session closes; and the fan-out of
 * server-initiated traffic, which is how diagnostics reach a tab at all.
 */
import { describe, it, expect, beforeEach, afterAll, mock } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { configService } from "../../../src/services/config.service.ts";
import { pathToFileUri } from "../../../src/shared/lsp-uri.ts";

const PROJECT = mkdtempSync(join(tmpdir(), "ppm-lsp-bridge-"));
mkdirSync(join(PROJECT, "src"), { recursive: true });
writeFileSync(join(PROJECT, "src", "a.ts"), "const a = 1;\n");
writeFileSync(join(PROJECT, "src", "b.ts"), "const b = 2;\n");
writeFileSync(join(PROJECT, "src", "c.py"), "c = 3\n");

/** A language server that answers when told to, and records what it was asked. */
class FakeSession {
  state = "ready";
  readonly definition = { id: "fake", displayName: "Fake" };
  readonly rootPath = PROJECT;
  readonly serverCapabilities = { hoverProvider: true };
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
let pythonSession: FakeSession;

/**
 * One session per *server and root*, which is what the manager really does — so two TypeScript
 * files share a key and a Python file does not. Release-on-last-doc is only a question at all
 * because of that sharing.
 */
const TS_KEY = "typescript /p";
const PY_KEY = "pyright /p";
const keyFor = (absolute: string) => (absolute.endsWith(".py") ? PY_KEY : TS_KEY);
const sessionFor = (key: string) => (key === PY_KEY ? pythonSession : session);

/** What the bridge told the manager to let go of. */
let released: Array<{ key: string; subscriber: string }> = [];
let releasedAll: string[] = [];

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
    acquire: async (_project: string, absolute: string) => {
      const key = keyFor(absolute);
      return { session: sessionFor(key), language: key === PY_KEY ? "python" : "typescript", key };
    },
    sessionFor: (key: string) => sessionFor(key),
    release: (key: string, subscriber: string) => void released.push({ key, subscriber }),
    releaseAll: (subscriber: string) => void releasedAll.push(subscriber),
    onNotification: () => () => {},
  },
}));

// `dispatchNotification` is called directly rather than through the listener the module hands
// the manager: that registration happens once, at import, and two other files in this suite
// import `ws/lsp.ts` for its pure helpers — so whether the mock or the real manager receives it
// depends on which file bun loads first. Two of the three cases below would still have passed
// with nothing delivered at all.
const { lspWebSocket, dispatchNotification } = await import("../../../src/server/ws/lsp.ts");

/** A socket, and the messages the bridge wrote back to it. */
function socket(path = "src/a.ts", clientUri = "inmemory://model/1") {
  const sent: Array<Record<string, unknown>> = [];
  const ws = {
    data: { type: "lsp", projectName: "demo" },
    send: (data: string) => void sent.push(JSON.parse(data)),
    close: () => {},
  };
  lspWebSocket.open(ws);
  const open = (p: string, uri: string) =>
    lspWebSocket.message(ws, JSON.stringify({ t: "open", path: p, text: "x\n", version: 1, clientUri: uri }));
  open(path, clientUri);
  return { ws, sent, open, ofType: (t: string) => sent.filter((m) => m.t === t) };
}

beforeEach(() => {
  session = new FakeSession();
  pythonSession = new FakeSession();
  released = [];
  releasedAll = [];
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

describe("an incremental change", () => {
  it("is forwarded when it applies to the version the bridge last saw", async () => {
    const s = socket();
    await Bun.sleep(0);

    lspWebSocket.message(s.ws, JSON.stringify({
      t: "change", path: "src/a.ts", version: 2,
      changes: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, text: "y" }],
    }));

    expect(session.notified.filter((n) => n.method === "textDocument/didChange")).toHaveLength(1);
    expect(s.ofType("resync")).toEqual([]);
  });

  it("is refused, and the document resent, when the stream skipped a version", async () => {
    // The server's copy is the whole point: applied out of order it drifts, and from then on
    // every completion and diagnostic refers to lines that no longer exist, with nothing
    // anywhere reporting a problem. Asking for the file back is the only recovery.
    const s = socket();
    await Bun.sleep(0);

    lspWebSocket.message(s.ws, JSON.stringify({
      t: "change", path: "src/a.ts", version: 5,
      changes: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, text: "y" }],
    }));

    expect(s.ofType("resync")).toEqual([{ t: "resync", path: "src/a.ts" }]);
    expect(session.notified.filter((n) => n.method === "textDocument/didChange")).toEqual([]);
  });

  it("takes a whole-document resend at any version, and carries on from it", async () => {
    // The resync reply is a full text, and it has to be accepted however far the version
    // jumped — otherwise the recovery asks for a resend that is refused for the same reason.
    const s = socket();
    await Bun.sleep(0);
    lspWebSocket.message(s.ws, JSON.stringify({ t: "change", path: "src/a.ts", version: 5, changes: [{ range: {}, text: "y" }] }));

    lspWebSocket.message(s.ws, JSON.stringify({ t: "change", path: "src/a.ts", version: 5, text: "whole file\n" }));
    lspWebSocket.message(s.ws, JSON.stringify({ t: "change", path: "src/a.ts", version: 6, changes: [{ range: {}, text: "z" }] }));

    const changes = session.notified.filter((n) => n.method === "textDocument/didChange");
    expect(changes).toHaveLength(2);
    expect((changes[0]!.params as { contentChanges: unknown[] }).contentChanges).toEqual([{ text: "whole file\n" }]);
    // One resync, from the skip — not a second one for the change that followed the resend.
    expect(s.ofType("resync")).toHaveLength(1);
  });

  it("ignores a change for a document this socket never opened", () => {
    const s = socket();
    expect(() => lspWebSocket.message(s.ws, JSON.stringify({ t: "change", path: "src/gone.ts", version: 2, text: "x" }))).not.toThrow();
    expect(session.notified).toEqual([]);
  });
});

describe("the hold on a session", () => {
  it("survives closing one of two documents that share it", async () => {
    // Closing one of ten TypeScript tabs would otherwise start the five-minute reap timer on
    // a server the other nine are still using.
    const s = socket();
    s.open("src/b.ts", "inmemory://model/2");
    await Bun.sleep(0);

    lspWebSocket.message(s.ws, JSON.stringify({ t: "close", path: "src/a.ts" }));

    expect(session.notified.filter((n) => n.method === "textDocument/didClose")).toHaveLength(1);
    expect(released).toEqual([]);
  });

  it("is given up when the last document on it closes", async () => {
    const s = socket();
    s.open("src/b.ts", "inmemory://model/2");
    await Bun.sleep(0);

    lspWebSocket.message(s.ws, JSON.stringify({ t: "close", path: "src/a.ts" }));
    lspWebSocket.message(s.ws, JSON.stringify({ t: "close", path: "src/b.ts" }));

    expect(released).toEqual([{ key: TS_KEY, subscriber: released[0]?.subscriber as string }]);
    expect(released[0]?.subscriber).toMatch(/^lsp-\d+$/);
  });

  it("is counted per session, so another server's document does not keep it alive", async () => {
    const s = socket();
    s.open("src/c.py", "inmemory://model/3");
    await Bun.sleep(0);

    lspWebSocket.message(s.ws, JSON.stringify({ t: "close", path: "src/a.ts" }));

    expect(released.map((r) => r.key)).toEqual([TS_KEY]);
    expect(pythonSession.notified.filter((n) => n.method === "textDocument/didClose")).toEqual([]);
  });

  it("is dropped wholesale when the socket goes away, after saying goodbye to each server", async () => {
    const s = socket();
    s.open("src/c.py", "inmemory://model/3");
    await Bun.sleep(0);

    lspWebSocket.close(s.ws);

    for (const fake of [session, pythonSession]) {
      expect(fake.notified.filter((n) => n.method === "textDocument/didClose")).toHaveLength(1);
    }
    expect(releasedAll).toHaveLength(1);
  });
});

describe("a notification from a server", () => {
  it("is what the bridge hands the manager, so a real one reaches a tab", () => {
    // The registration happens once, at import, and is therefore not observable from here —
    // see the note above the import. This is the line that makes the function called below the
    // one production runs.
    const src = readFileSync(resolve(import.meta.dir, "../../../src/server/ws/lsp.ts"), "utf8");
    expect(src).toContain("lspManager.onNotification(dispatchNotification)");
  });

  it("reaches the tab holding a document on that session, with its URI in the tab's terms", async () => {
    // Diagnostics name their document by `file:` URI. Unrewritten, Monaco cannot tell which
    // model they belong to and shows none at all — the feature is simply absent.
    const s = socket();
    await Bun.sleep(0);

    dispatchNotification(TS_KEY, "textDocument/publishDiagnostics", {
      uri: pathToFileUri(join(PROJECT, "src", "a.ts")),
      diagnostics: [{ message: "bad" }],
    });

    expect(s.ofType("notification")).toEqual([{
      t: "notification",
      method: "textDocument/publishDiagnostics",
      params: { uri: "inmemory://model/1", diagnostics: [{ message: "bad" }] },
    }]);
  });

  it("is not delivered to a tab with nothing on that session", async () => {
    // One session is shared between tabs, so a listener per socket would hand every tab every
    // other tab's diagnostics — markers for a file that tab never opened.
    const s = socket();
    await Bun.sleep(0);

    dispatchNotification(PY_KEY, "textDocument/publishDiagnostics", { uri: pathToFileUri(join(PROJECT, "src", "c.py")), diagnostics: [] });

    expect(s.ofType("notification")).toEqual([]);
  });

  it("stops going to a socket that has closed", async () => {
    const s = socket();
    await Bun.sleep(0);
    lspWebSocket.close(s.ws);

    dispatchNotification(TS_KEY, "textDocument/publishDiagnostics", { uri: pathToFileUri(join(PROJECT, "src", "a.ts")), diagnostics: [] });

    expect(s.ofType("notification")).toEqual([]);
  });
});
