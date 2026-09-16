/**
 * Monaco's `CancellationToken`, from the provider it is handed to down to the socket.
 *
 * A language server answers one request at a time, so a superseded completion is not free:
 * it sits in front of the one the user is waiting for. Monaco cancels the moment the next
 * keystroke arrives — every provider is given a token for exactly this — and until it was
 * threaded through, `$/cancelRequest` was only ever sent on a fifteen-second timeout. Typing
 * eight characters into a large TypeScript file queued eight completions, and the list that
 * finally opened was the one for a prefix several keystrokes old.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type * as MonacoType from "monaco-editor";
import { registerLspProviders } from "../../../src/web/lib/lsp/register-providers.ts";
import { registerLspDocument, unregisterLspDocument } from "../../../src/web/lib/lsp/lsp-documents.ts";
import type { LspConnection } from "../../../src/web/lib/lsp/lsp-client.ts";

const SOURCE = resolve(import.meta.dir, "../../../src/web/lib/lsp/register-providers.ts");

/** Every provider Monaco was given, by the method the provider object carries. */
const providers = new Map<string, Record<string, (...args: never[]) => unknown>>();

const monaco = {
  editor: { registerCommand: () => {} },
  languages: new Proxy({} as Record<string, unknown>, {
    get: (_target, name: string) => {
      // Monaco's own numbering, which is not LSP's: Invoke = 0, TriggerCharacter = 1, where
      // LSP counts from one. Returning a bare `{}` here made every trigger look like an
      // invocation and the request went out either way — so the test hung instead of failing.
      if (name === "CompletionTriggerKind") return { Invoke: 0, TriggerCharacter: 1, TriggerForIncompleteCompletions: 2 };
      if (!name.startsWith("register")) return {};
      return (_language: string, provider: Record<string, (...args: never[]) => unknown>) => {
        for (const key of Object.keys(provider)) {
          if (typeof provider[key] === "function" && key.startsWith("provide")) providers.set(key, provider);
        }
        return { dispose: () => {} };
      };
    },
  }),
} as unknown as typeof MonacoType;

registerLspProviders(monaco);

/** A token shaped like Monaco's, which even `CancellationToken.None` is. */
function cancellation() {
  const listeners = new Set<() => void>();
  return {
    isCancellationRequested: false,
    onCancellationRequested(cb: () => void) {
      listeners.add(cb);
      return { dispose: () => listeners.delete(cb) };
    },
    cancel() {
      this.isCancellationRequested = true;
      for (const cb of listeners) cb();
    },
  };
}

function fakeModel(uri: string): MonacoType.editor.ITextModel {
  return {
    uri: { toString: () => uri },
    getLanguageId: () => "typescript",
    getWordAtPosition: () => null,
    getWordUntilPosition: () => ({ word: "", startColumn: 1, endColumn: 1 }),
  } as unknown as MonacoType.editor.ITextModel;
}

const model = fakeModel("inmemory://model/1");

/** A connection that never answers, so a request is only ever ended by its signal. */
function pending() {
  const signals: Array<AbortSignal | undefined> = [];
  const connection = {
    statusOf: () => ({
      state: "ready",
      capabilities: {
        completionProvider: {}, hoverProvider: true, definitionProvider: true,
        referencesProvider: true, documentHighlightProvider: true, documentSymbolProvider: true,
        renameProvider: true, documentFormattingProvider: true, documentRangeFormattingProvider: true,
        codeActionProvider: true, inlayHintProvider: true, signatureHelpProvider: {},
        typeDefinitionProvider: true, implementationProvider: true,
      },
    }),
    request: (_path: string, _method: string, _params: unknown, options?: { signal?: AbortSignal }) => {
      signals.push(options?.signal);
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      });
    },
  } as unknown as LspConnection;
  registerLspDocument(model, { connection, path: "src/a.ts" });
  return { signals, done: () => unregisterLspDocument(model) };
}

const position = { lineNumber: 1, column: 1 } as MonacoType.Position;
const range = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 };

/** The arguments each provider takes before its token, in Monaco's own order. */
const CALLS: Array<[string, unknown[]]> = [
  ["provideCompletionItems", [model, position, { triggerKind: 0 }]],
  ["provideHover", [model, position]],
  ["provideSignatureHelp", [model, position]],
  ["provideDefinition", [model, position]],
  ["provideTypeDefinition", [model, position]],
  ["provideImplementation", [model, position]],
  ["provideReferences", [model, position, { includeDeclaration: true }]],
  ["provideDocumentHighlights", [model, position]],
  ["provideDocumentSymbols", [model]],
  ["provideRenameEdits", [model, position, "newName"]],
  ["provideDocumentFormattingEdits", [model, { tabSize: 2, insertSpaces: true }]],
  ["provideDocumentRangeFormattingEdits", [model, range, { tabSize: 2, insertSpaces: true }]],
  ["provideCodeActions", [model, range, { only: undefined }]],
  ["provideInlayHints", [model, range]],
];

describe("every provider forwards Monaco's cancellation", () => {
  it("registered the providers this test knows about", () => {
    // If Monaco's registration surface changes, the loop below would silently test nothing.
    expect([...providers.keys()].sort()).toEqual(CALLS.map(([name]) => name).sort());
  });

  for (const [name, args] of CALLS) {
    it(`${name} stops the request when the token is cancelled`, async () => {
      const { signals, done } = pending();
      const token = cancellation();

      const provider = providers.get(name)!;
      const inflight = provider[name]!(...([...args, token] as never[]));
      await Promise.resolve();

      expect(signals).toHaveLength(1);
      expect(signals[0]?.aborted).toBe(false);
      token.cancel();
      expect(signals[0]?.aborted).toBe(true);

      // A provider never throws: Monaco treats a rejection as a broken provider and can stop
      // asking, so a cancelled request still comes back as "no answer".
      await expect(inflight).resolves.toBeDefined();
      done();
    });
  }

  it("passes the token at every call site, including ones added later", () => {
    // The behavioural tests above cover the providers that exist today. This is what fails
    // when a new one is written without a token, which looks entirely ordinary in review.
    const src = readFileSync(SOURCE, "utf8");
    const missing: string[] = [];
    for (let i = src.indexOf("await ask<"); i !== -1; i = src.indexOf("await ask<", i + 1)) {
      let depth = 0;
      let end = src.indexOf("(", i);
      for (let j = end; j < src.length; j++) {
        if (src[j] === "(") depth++;
        else if (src[j] === ")" && --depth === 0) { end = j; break; }
      }
      const call = src.slice(i, end + 1);
      if (!/,\s*token\s*,?\s*\)$/.test(call.replace(/\s+/g, " "))) {
        missing.push(/"([^"]+)"/.exec(call)?.[1] ?? call.slice(0, 60));
      }
    }
    expect(missing).toEqual([]);
  });
});

describe("which characters open the suggest list", () => {
  const TRIGGER = 1; // Monaco's CompletionTriggerKind.TriggerCharacter — LSP's is 2

  /**
   * A connection that answers at once.
   *
   * Deliberately not the never-settling one above: a regression here makes the request go out,
   * and against a stub that never answers that shows up as a hung suite rather than a red test.
   */
  function answering(completionProvider: Record<string, unknown>) {
    const asked: Array<Record<string, unknown>> = [];
    const connection = {
      statusOf: () => ({ state: "ready", capabilities: { completionProvider } }),
      request: async (_path: string, _method: string, params: unknown) => {
        asked.push(params as Record<string, unknown>);
        return { items: [] };
      },
    } as unknown as LspConnection;
    registerLspDocument(model, { connection, path: "src/a.ts" });
    return { asked, done: () => unregisterLspDocument(model) };
  }

  async function complete(
    context: { triggerKind: number; triggerCharacter?: string },
    completionProvider: Record<string, unknown>,
  ) {
    const state = answering(completionProvider);
    const result = await providers.get("provideCompletionItems")!.provideCompletionItems!(
      model as never, { lineNumber: 1, column: 1 } as never, context as never, cancellation() as never,
    );
    state.done();
    return { asked: state.asked, result };
  }

  it("ignores a character this server never asked for", async () => {
    // Monaco is told a union of trigger characters, because the provider is registered before
    // any server is known — and space is in it, for the servers that want it. Answering it for
    // every server is what put the suggest widget on screen at every press of the space bar,
    // in every string and every comment.
    const { asked, result } = await complete(
      { triggerKind: TRIGGER, triggerCharacter: " " },
      { triggerCharacters: ["."] },
    );

    expect(result).toEqual({ suggestions: [] });
    expect(asked).toEqual([]);
  });

  it("asks when the character is one the server advertised", async () => {
    const { asked } = await complete(
      { triggerKind: TRIGGER, triggerCharacter: "." },
      { triggerCharacters: [".", " "] },
    );

    expect(asked).toHaveLength(1);
    // LSP numbers these from one, Monaco from zero.
    expect(asked[0]!.context).toEqual({ triggerKind: 2, triggerCharacter: "." });
  });

  it("still answers an explicit invocation, whatever the server advertised", async () => {
    // Ctrl+Space arrives as an invocation rather than a character, so it must always go
    // through — including for a server that advertises no trigger characters at all.
    const { asked } = await complete({ triggerKind: 0 }, {});

    expect(asked).toHaveLength(1);
    expect(asked[0]!.context).toEqual({ triggerKind: 1, triggerCharacter: undefined });
  });
});

describe("resolving a suggestion", () => {
  /** A connection that answers a completion list, then records the resolve it is asked for. */
  function server(name: string, path: string) {
    const asked: Array<{ method: string; params: unknown }> = [];
    const connection = {
      statusOf: () => ({ state: "ready", capabilities: { completionProvider: {} } }),
      request: async (_path: string, method: string, params: unknown) => {
        asked.push({ method, params });
        return method === "textDocument/completion"
          ? { items: [{ label: name, data: { from: name } }] }
          : { detail: `resolved by ${name}` };
      },
    } as unknown as LspConnection;
    return { asked, document: { connection, path } };
  }

  it("asks the server that issued the item, not whichever project came first", async () => {
    // Two projects open on `src/index.ts` are two different files on two different servers.
    // Looking the model back up by its project-relative path found whichever Monaco listed
    // first, so a suggestion from one project could be resolved against the other's server.
    const mine = server("mine", "src/index.ts");
    const theirs = server("theirs", "src/index.ts");
    const otherModel = fakeModel("inmemory://model/2");

    // Monaco lists the other project's model first, which is what the old lookup found.
    registerLspDocument(otherModel, theirs.document);
    registerLspDocument(model, mine.document);

    const provider = providers.get("provideCompletionItems")!;
    const list = (await provider.provideCompletionItems!(
      model as never,
      { lineNumber: 1, column: 1 } as never,
      { triggerKind: 0 } as never,
      cancellation() as never,
    )) as { suggestions: unknown[] };

    const resolved = await provider.resolveCompletionItem!(list.suggestions[0] as never, cancellation() as never);

    expect((resolved as { detail?: string }).detail).toBe("resolved by mine");
    expect(theirs.asked).toEqual([]);
    expect(mine.asked.map((a) => a.method)).toEqual(["textDocument/completion", "completionItem/resolve"]);
    // The item goes back exactly as it arrived: `data` is the server's own token.
    expect(mine.asked[1]!.params).toMatchObject({ label: "mine", data: { from: "mine" } });

    unregisterLspDocument(model);
    unregisterLspDocument(otherModel);
  });
});
