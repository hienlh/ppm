/**
 * The code-action request carries what the server last published for the file — and what it
 * last published reaches the request only through `useLsp`, which keeps each
 * `publishDiagnostics` on the document the providers read. The provider half is pinned next
 * door with the list filled in by hand; this one goes through the hook, the real connection and
 * the real providers, with only the socket and Monaco faked, so the hand-off itself is covered.
 */
import { expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

it("hands the diagnostics a server published to its next code-action request", () => {
  // Module mocks stay in a child process so other suites keep the real socket client.
  const result = Bun.spawnSync([process.execPath, "--eval", `
    import { mock } from "bun:test";
    import { installDom } from "./tests/helpers/react-dom";
    installDom();
    const sockets = [];
    class FakeWs {
      constructor(url) { this.url = url; this.sent = []; this.handler = null; sockets.push(this); }
      onMessage(handler) { this.handler = handler; }
      connect() {} close() {} disconnect() {}
      send(data) { this.sent.push(JSON.parse(data)); }
      deliver(message) { this.handler?.({ data: JSON.stringify(message) }); }
    }
    mock.module("@/lib/ws-client", () => ({ WsClient: FakeWs }));

    let provideCodeActions;
    const before = (l1, c1, l2, c2) => l1 < l2 || (l1 === l2 && c1 < c2);
    const monaco = {
      editor: { registerCommand() {}, setModelMarkers() {} },
      MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
      Range: {
        areIntersectingOrTouching: (a, b) =>
          !before(a.endLineNumber, a.endColumn, b.startLineNumber, b.startColumn) &&
          !before(b.endLineNumber, b.endColumn, a.startLineNumber, a.startColumn),
      },
      languages: new Proxy({}, {
        get: (_target, name) => {
          if (name === "CompletionTriggerKind") return { Invoke: 0, TriggerCharacter: 1, TriggerForIncompleteCompletions: 2 };
          if (typeof name !== "string" || !name.startsWith("register")) return {};
          return (language, provider) => {
            if (language === "typescript" && provider?.provideCodeActions) provideCodeActions = provider.provideCodeActions;
            return { dispose() {} };
          };
        },
      }),
    };
    const model = {
      uri: { toString: () => "inmemory://model/7" },
      getLanguageId: () => "typescript",
      getValue: () => "const answer = answe;\\n",
      getVersionId: () => 1,
      onDidChangeContent: () => ({ dispose() {} }),
    };
    const editor = { getModel: () => model };

    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { useLsp } = await import("./src/web/hooks/use-lsp");
    function Probe() {
      useLsp({ editor, monaco, projectName: "demo", filePath: "src/a.ts", enabled: true });
      return null;
    }
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await React.act(async () => { root.render(React.createElement(Probe)); });

    const ws = sockets.find((s) => s.url.endsWith("/lsp"));
    const published = {
      range: { start: { line: 0, character: 15 }, end: { line: 0, character: 20 } },
      message: "Cannot find name 'answe'. Did you mean 'answer'?",
      code: 2552,
      data: { fixId: "spelling" },
    };
    await React.act(async () => {
      ws.deliver({ t: "ready", path: "src/a.ts", languageId: "typescript", projectPath: "/p",
        server: { id: "typescript", displayName: "TypeScript", rootPath: "/p" }, capabilities: { codeActionProvider: true } });
      ws.deliver({ t: "notification", method: "textDocument/publishDiagnostics",
        params: { uri: "inmemory://model/7", diagnostics: [published] } });
    });

    // The cursor inside the misspelt name: Monaco is 1-based, so line 1, column 17.
    const asked = provideCodeActions(model, { startLineNumber: 1, startColumn: 17, endLineNumber: 1, endColumn: 17 }, { only: undefined }, undefined);
    const request = ws.sent.find((m) => m.t === "request" && m.method === "textDocument/codeAction");
    ws.deliver({ t: "response", id: request?.id, result: [] });
    await asked;
    await React.act(async () => { root.unmount(); });
    console.log(JSON.stringify({ diagnostics: request?.params?.context?.diagnostics ?? null }));
  `], {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    // The child keeps this run's throwaway PPM_HOME; Bun hands a child the environment the
    // process started with, not what the test setup wrote into it since.
    env: { ...process.env },
    stdout: "pipe", stderr: "pipe",
  });
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
  const lines = result.stdout.toString().trim().split("\n");
  const { diagnostics } = JSON.parse(lines[lines.length - 1]!);
  expect(diagnostics).toEqual([{
    range: { start: { line: 0, character: 15 }, end: { line: 0, character: 20 } },
    message: "Cannot find name 'answe'. Did you mean 'answer'?",
    code: 2552,
    data: { fixId: "spelling" },
  }]);
});
