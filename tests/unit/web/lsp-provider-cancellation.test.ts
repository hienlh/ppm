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

const model = {
  uri: { toString: () => "inmemory://model/1" },
  getLanguageId: () => "typescript",
  getWordAtPosition: () => null,
} as unknown as MonacoType.editor.ITextModel;

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
