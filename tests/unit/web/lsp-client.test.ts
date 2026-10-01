/**
 * The browser half of the bridge: withdrawing a request, and the last editor going away.
 *
 * A language server answers one request at a time, so a superseded completion is not free —
 * it sits in front of the one the user is waiting for. Monaco hands every provider a
 * `CancellationToken` and cancels the moment the next keystroke arrives; the only thing that
 * takes the request out of the server's queue is `$/cancelRequest`, at the far end of the
 * bridge, and nothing here listened to the token at all.
 */
import { describe, it, expect, beforeEach, mock } from "bun:test";

/** A socket that records what was written and hands back what the bridge would say. */
class FakeWs {
  static last: FakeWs | null = null;
  readonly sent: Array<Record<string, unknown>> = [];
  private handler: ((event: { data: string }) => void) | null = null;
  constructor(readonly url: string) {
    FakeWs.last = this;
  }
  onMessage(handler: (event: { data: string }) => void): void {
    this.handler = handler;
  }
  connect(): void {}
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {}
  disconnect(): void {}
  /** Deliver a message as if the bridge had sent it. */
  deliver(message: unknown): void {
    this.handler?.({ data: JSON.stringify(message) });
  }
  ofType(type: string): Array<Record<string, unknown>> {
    return this.sent.filter((m) => m.t === type);
  }
}

// Process-wide, and not undone by anything this file can run: `mock.module` replaces the
// module for every test file, and restoring it in `afterAll` is far too late, because the
// suites that import it have already bound their copy. `ws-client.test.ts` therefore asks for
// the module by a specifier this cannot reach — see the note on its import.
mock.module("@/lib/ws-client", () => ({ WsClient: FakeWs }));

const { LspConnection, acquireLspConnection, releaseLspConnection, retryUnavailableLspDocuments } =
  await import("../../../src/web/lib/lsp/lsp-client.ts");

/** A connection with one document the bridge has already reported ready. */
function connected() {
  const connection = new LspConnection("demo");
  const ws = FakeWs.last!;
  connection.open("src/a.ts", { getText: () => "", getVersion: () => 1, clientUri: "inmemory://model/1" });
  ws.deliver({
    t: "ready",
    path: "src/a.ts",
    languageId: "typescript",
    server: { id: "ts", displayName: "TypeScript", rootPath: "/p" },
    projectPath: "/p",
    capabilities: { completionProvider: {} },
  });
  return { connection, ws };
}

beforeEach(() => {
  FakeWs.last = null;
});

describe("LspConnection.request with a signal", () => {
  it("withdraws the request when the caller aborts", async () => {
    const { connection, ws } = connected();
    const controller = new AbortController();

    const inflight = connection.request("src/a.ts", "textDocument/completion", {}, { signal: controller.signal });
    const id = ws.ofType("request")[0]!.id;
    controller.abort();

    await expect(inflight).rejects.toThrow(/textDocument\/completion was cancelled/);
    expect(ws.ofType("cancel")).toEqual([{ t: "cancel", id }]);
  });

  it("does not withdraw a request that already answered", async () => {
    const { connection, ws } = connected();
    const controller = new AbortController();

    const inflight = connection.request("src/a.ts", "textDocument/hover", {}, { signal: controller.signal });
    ws.deliver({ t: "response", id: ws.ofType("request")[0]!.id, result: { contents: "x" } });
    await expect(inflight).resolves.toEqual({ contents: "x" });
    // The token is cancelled after the answer arrives on every completed request Monaco makes.
    controller.abort();

    expect(ws.ofType("cancel")).toEqual([]);
  });

  it("never sends a request that was cancelled before it was made", async () => {
    const { connection, ws } = connected();
    const controller = new AbortController();
    controller.abort();

    await expect(
      connection.request("src/a.ts", "textDocument/completion", {}, { signal: controller.signal }),
    ).rejects.toThrow(/was cancelled/);

    expect(ws.ofType("request")).toEqual([]);
    expect(ws.ofType("cancel")).toEqual([]);
  });

  it("still withdraws on its own timeout, with no signal at all", async () => {
    const { connection, ws } = connected();

    const inflight = connection.request("src/a.ts", "textDocument/completion", {}, { timeoutMs: 20 });

    await expect(inflight).rejects.toThrow(/timed out/);
    expect(ws.ofType("cancel")).toHaveLength(1);
  });
});

describe("asking again after an install", () => {
  /** A connection with one document the bridge has reported as having no server. */
  function missing(path = "src/a.ts") {
    const connection = new LspConnection("demo");
    const ws = FakeWs.last!;
    connection.open(path, { getText: () => "x", getVersion: () => 1, clientUri: "inmemory://model/1" });
    ws.deliver({
      t: "unavailable",
      path,
      reason: "not-installed",
      server: { id: "typescript", displayName: "TypeScript", installHint: "…", installable: true },
      message: "TypeScript is not installed.",
    });
    return { connection, ws };
  }

  it("reopens the documents that had no server", () => {
    // The file is already open. Closing and reopening the tab to pick up a server that has
    // just appeared is the step the Install button exists to remove.
    const { connection, ws } = missing();
    expect(ws.ofType("open")).toHaveLength(1);

    connection.retryUnavailable();

    expect(ws.ofType("open")).toHaveLength(2);
    expect(connection.statusOf("src/a.ts")).toEqual({ state: "opening" });
  });

  it("leaves a document that already has a server alone", () => {
    // Reopening a ready document would take a working server away from a tab that is using it.
    const { connection, ws } = connected();

    connection.retryUnavailable();

    expect(ws.ofType("open")).toHaveLength(1);
    expect(connection.statusOf("src/a.ts")).toMatchObject({ state: "ready" });
  });

  it("asks on every project's connection, not just the one that was open", () => {
    // One `bun add` serves every project at once, and the editors of the others are still
    // mounted behind the tab pool — claiming a server is missing that is now installed.
    const first = acquireLspConnection("one");
    const firstWs = FakeWs.last!;
    const second = acquireLspConnection("two");
    const secondWs = FakeWs.last!;
    for (const [connection, ws] of [[first, firstWs], [second, secondWs]] as const) {
      connection.open("src/a.ts", { getText: () => "", getVersion: () => 1, clientUri: "inmemory://model/1" });
      ws.deliver({ t: "unavailable", path: "src/a.ts", reason: "not-installed", server: null, message: "no" });
    }

    retryUnavailableLspDocuments();

    expect(firstWs.ofType("open")).toHaveLength(2);
    expect(secondWs.ofType("open")).toHaveLength(2);
    releaseLspConnection("one");
    releaseLspConnection("two");
  });
});

describe("the shared connection's holders", () => {
  it("reports the release that was the last one", () => {
    // Which is how anything gets to know a project has no editor open any more — the shadow
    // models are forty files' contents that nothing can resolve after that point, and
    // `disposeShadowModels` had been exported and never called.
    acquireLspConnection("demo");
    acquireLspConnection("demo");

    expect(releaseLspConnection("demo")).toBe(false);
    expect(releaseLspConnection("demo")).toBe(true);
    // And a release with nothing to release is not the last one either.
    expect(releaseLspConnection("demo")).toBe(false);
  });

  it("hands the same connection to every editor on one project", () => {
    const first = acquireLspConnection("demo");
    const second = acquireLspConnection("demo");

    expect(second).toBe(first);
    expect(acquireLspConnection("other")).not.toBe(first);

    releaseLspConnection("demo");
    releaseLspConnection("demo");
    releaseLspConnection("other");
  });
});
