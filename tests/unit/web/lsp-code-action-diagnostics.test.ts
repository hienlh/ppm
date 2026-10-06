/**
 * A code-action request carries the diagnostics the server published for the range it asks
 * about. Servers find their quick fixes from that list — typescript-language-server answers an
 * empty one with no quick fixes at all — so sending `[]` meant no error ever had its "Add
 * import" or "Change spelling" in the lightbulb, even with the language server running.
 */
import { expect, it } from "bun:test";
import type * as MonacoType from "monaco-editor";
import { registerLspDocument, unregisterLspDocument, type LspDocument } from "../../../src/web/lib/lsp/lsp-documents.ts";
import type { LspConnection } from "../../../src/web/lib/lsp/lsp-client.ts";

// Its own instance: registration is once per language for the whole module, and another test
// file may already have registered against a different fake.
const { registerLspProviders } = await import("../../../src/web/lib/lsp/register-providers.ts?code-action-diagnostics");

type IRange = { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };
const before = (l1: number, c1: number, l2: number, c2: number) => l1 < l2 || (l1 === l2 && c1 < c2);

let provideCodeActions: ((...args: unknown[]) => Promise<unknown>) | undefined;
const monaco = {
  editor: { registerCommand: () => {} },
  // Monaco's semantics: ranges that share even one position.
  Range: {
    areIntersectingOrTouching: (a: IRange, b: IRange) =>
      !before(a.endLineNumber, a.endColumn, b.startLineNumber, b.startColumn) &&
      !before(b.endLineNumber, b.endColumn, a.startLineNumber, a.startColumn),
  },
  languages: new Proxy({} as Record<string, unknown>, {
    get: (_target, name: string) => {
      if (name === "CompletionTriggerKind") return { Invoke: 0, TriggerCharacter: 1, TriggerForIncompleteCompletions: 2 };
      if (!name.startsWith("register")) return {};
      return (language: string, provider: { provideCodeActions?: (...args: unknown[]) => Promise<unknown> }) => {
        if (language === "typescript" && provider.provideCodeActions) provideCodeActions = provider.provideCodeActions;
        return { dispose: () => {} };
      };
    },
  }),
} as unknown as typeof MonacoType;

registerLspProviders(monaco);

const lspRange = (line: number, from: number, to: number) => ({ start: { line, character: from }, end: { line, character: to } });

it("hands the server back the diagnostics it published for the range, exactly as it sent them", async () => {
  const model = { uri: { toString: () => "inmemory://model/7" }, getLanguageId: () => "typescript" } as unknown as MonacoType.editor.ITextModel;
  const requests: Array<{ method: string; params: any }> = [];
  const connection = {
    statusOf: () => ({ state: "ready", capabilities: { codeActionProvider: true } }),
    request: async (_path: string, method: string, params: unknown) => {
      requests.push({ method, params });
      return [];
    },
  } as unknown as LspConnection;
  // `data` is what some servers match a fix on, and a Monaco marker does not keep it.
  const misspelt = { range: lspRange(3, 12, 17), message: "Cannot find name 'answe'.", code: 2552, data: { fixId: "spelling" } };
  const unused = { range: lspRange(9, 0, 6), message: "'x' is declared but its value is never read.", code: 6133 };
  const document: LspDocument = { connection, path: "src/a.ts", diagnostics: [misspelt, unused] };
  registerLspDocument(model, document);
  try {
    expect(provideCodeActions).toBeDefined();
    // The cursor inside the misspelt name (Monaco is 1-based: line 4, column 15).
    await provideCodeActions!(model, { startLineNumber: 4, startColumn: 15, endLineNumber: 4, endColumn: 15 }, { only: undefined });
    expect(requests.map((r) => r.method)).toEqual(["textDocument/codeAction"]);
    expect(requests[0]!.params.context.diagnostics).toEqual([misspelt]);
    expect(requests[0]!.params.context.diagnostics[0]).toBe(misspelt);

    // A cursor touching nothing sends none; a file nothing was published for, none either.
    await provideCodeActions!(model, { startLineNumber: 6, startColumn: 1, endLineNumber: 6, endColumn: 1 }, { only: undefined });
    expect(requests[1]!.params.context.diagnostics).toEqual([]);
    document.diagnostics = undefined;
    await provideCodeActions!(model, { startLineNumber: 4, startColumn: 15, endLineNumber: 4, endColumn: 15 }, { only: undefined });
    expect(requests[2]!.params.context.diagnostics).toEqual([]);
  } finally {
    unregisterLspDocument(model);
  }
});
