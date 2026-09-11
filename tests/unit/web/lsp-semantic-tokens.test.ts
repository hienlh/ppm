/**
 * Reading a server's semantic token legend, and registering one provider for it.
 *
 * The legend is the whole risk here. A semantic token is an index, so decoding
 * with the wrong legend does not fail — it produces tokens of some other,
 * entirely plausible kind, and the file is coloured confidently and wrongly. So
 * the tests cover refusing to register without a legend, and replacing the
 * provider when a different server brings a different one.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import type * as MonacoType from "monaco-editor";
import {
  registerSemanticTokens,
  resetSemanticTokens,
  semanticTokensLegendOf,
  supportsDelta,
} from "../../../src/web/lib/lsp/lsp-semantic-tokens.ts";
import { registerLspDocument, unregisterLspDocument } from "../../../src/web/lib/lsp/lsp-documents.ts";
import type { LspConnection } from "../../../src/web/lib/lsp/lsp-client.ts";

const LEGEND = { tokenTypes: ["class", "function"], tokenModifiers: ["declaration"] };

/** Records what was registered, and whether it was disposed. */
function fakeMonaco() {
  const registrations: Array<{
    language: string;
    provider: MonacoType.languages.DocumentSemanticTokensProvider;
    disposed: boolean;
  }> = [];

  const monaco = {
    languages: {
      registerDocumentSemanticTokensProvider(
        language: string,
        provider: MonacoType.languages.DocumentSemanticTokensProvider,
      ) {
        const entry = { language, provider, disposed: false };
        registrations.push(entry);
        return { dispose: () => { entry.disposed = true; } };
      },
    },
  } as unknown as typeof MonacoType;

  return { monaco, registrations };
}

/** A model whose only job is to carry a URI and a language. */
function fakeModel(uri = "inmemory://model/1") {
  return {
    uri: { toString: () => uri },
    getLanguageId: () => "typescript",
  } as unknown as MonacoType.editor.ITextModel;
}

interface Asked {
  method: string;
  params: Record<string, unknown>;
}

function fakeDocument(
  answer: unknown,
  capabilities: Record<string, unknown> = { semanticTokensProvider: { legend: LEGEND, full: true } },
) {
  const asked: Asked[] = [];
  const connection = {
    statusOf: () => ({ state: "ready", capabilities }),
    request: async (_path: string, method: string, params: Record<string, unknown>) => {
      asked.push({ method, params });
      if (answer instanceof Error) throw answer;
      return answer;
    },
  } as unknown as LspConnection;

  return { document: { connection, path: "src/a.ts" }, asked };
}

beforeEach(() => {
  resetSemanticTokens();
});

describe("semanticTokensLegendOf", () => {
  it("reads the legend a server advertised", () => {
    expect(semanticTokensLegendOf({ semanticTokensProvider: { legend: LEGEND } })).toEqual(LEGEND);
  });

  it("is null when the server offers no semantic tokens at all", () => {
    expect(semanticTokensLegendOf({ hoverProvider: true })).toBeNull();
  });

  it("is null when the provider carries no legend", () => {
    // Nothing to decode with, so registering would colour by guesswork.
    expect(semanticTokensLegendOf({ semanticTokensProvider: { full: true } })).toBeNull();
  });

  it("is null for an empty token type list", () => {
    expect(
      semanticTokensLegendOf({ semanticTokensProvider: { legend: { tokenTypes: [], tokenModifiers: [] } } }),
    ).toBeNull();
  });

  it("defaults absent modifiers to an empty list", () => {
    const legend = semanticTokensLegendOf({ semanticTokensProvider: { legend: { tokenTypes: ["class"] } } });

    expect(legend).toEqual({ tokenTypes: ["class"], tokenModifiers: [] });
  });
});

describe("supportsDelta", () => {
  it("is true only when the server says delta", () => {
    expect(supportsDelta({ semanticTokensProvider: { full: { delta: true } } })).toBe(true);
  });

  it("is false for plain full support", () => {
    // What typescript-language-server actually advertises.
    expect(supportsDelta({ semanticTokensProvider: { full: true } })).toBe(false);
  });

  it("is false when there is no provider", () => {
    expect(supportsDelta({})).toBe(false);
  });
});

describe("registerSemanticTokens", () => {
  it("registers one provider for the language", () => {
    const { monaco, registrations } = fakeMonaco();

    registerSemanticTokens(monaco, "typescript", LEGEND);

    expect(registrations).toHaveLength(1);
    expect(registrations[0]!.language).toBe("typescript");
    expect(registrations[0]!.provider.getLegend()).toEqual(LEGEND);
  });

  it("does nothing on a second call with the same legend", () => {
    // Called from every editor mount, so this is the common path.
    const { monaco, registrations } = fakeMonaco();

    registerSemanticTokens(monaco, "typescript", LEGEND);
    registerSemanticTokens(monaco, "typescript", { ...LEGEND });

    expect(registrations).toHaveLength(1);
  });

  it("replaces the provider when the legend changes", () => {
    // A different server for the same language indexes into its own table.
    const { monaco, registrations } = fakeMonaco();

    registerSemanticTokens(monaco, "typescript", LEGEND);
    registerSemanticTokens(monaco, "typescript", { tokenTypes: ["variable"], tokenModifiers: [] });

    expect(registrations).toHaveLength(2);
    expect(registrations[0]!.disposed).toBe(true);
    expect(registrations[1]!.disposed).toBe(false);
  });

  it("keeps languages independent", () => {
    const { monaco, registrations } = fakeMonaco();

    registerSemanticTokens(monaco, "typescript", LEGEND);
    registerSemanticTokens(monaco, "python", LEGEND);

    expect(registrations.map((r) => r.language)).toEqual(["typescript", "python"]);
  });
});

describe("provideDocumentSemanticTokens", () => {
  const model = fakeModel();

  it("passes the server's numbers through as a Uint32Array", () => {
    // LSP's relative encoding is Monaco's, so the data is never rewritten —
    // only retyped. Rewriting it is how tokens end up one line off.
    const { monaco, registrations } = fakeMonaco();
    const { document } = fakeDocument({ resultId: "1", data: [0, 4, 3, 0, 1] });
    registerLspDocument(model, document);
    registerSemanticTokens(monaco, "typescript", LEGEND);

    return registrations[0]!.provider
      .provideDocumentSemanticTokens(model, null, {} as never)
      .then((result: unknown) => {
        const tokens = result as { resultId?: string; data: Uint32Array };
        expect(tokens.resultId).toBe("1");
        expect(tokens.data).toBeInstanceOf(Uint32Array);
        expect(Array.from(tokens.data)).toEqual([0, 4, 3, 0, 1]);
        unregisterLspDocument(model);
      });
  });

  it("asks for the whole document when there is no previous result", async () => {
    const { monaco, registrations } = fakeMonaco();
    const { document, asked } = fakeDocument({ data: [] });
    registerLspDocument(model, document);
    registerSemanticTokens(monaco, "typescript", LEGEND);

    await registrations[0]!.provider.provideDocumentSemanticTokens(model, null, {} as never);

    expect(asked[0]!.method).toBe("textDocument/semanticTokens/full");
    expect(asked[0]!.params.textDocument).toEqual({ uri: "inmemory://model/1" });
    unregisterLspDocument(model);
  });

  it("asks for a delta only when the server supports one", async () => {
    const { monaco, registrations } = fakeMonaco();
    const { document, asked } = fakeDocument(
      { resultId: "2", edits: [{ start: 0, deleteCount: 5, data: [1, 0, 3, 1, 0] }] },
      { semanticTokensProvider: { legend: LEGEND, full: { delta: true } } },
    );
    registerLspDocument(model, document);
    registerSemanticTokens(monaco, "typescript", LEGEND);

    const result = (await registrations[0]!.provider.provideDocumentSemanticTokens(model, "1", {} as never)) as {
      edits: Array<{ start: number; deleteCount: number; data?: Uint32Array }>;
    };

    expect(asked[0]!.method).toBe("textDocument/semanticTokens/full/delta");
    expect(asked[0]!.params.previousResultId).toBe("1");
    expect(result.edits[0]!.data).toBeInstanceOf(Uint32Array);
    unregisterLspDocument(model);
  });

  it("falls back to a full request when the server has no delta support", async () => {
    // typescript-language-server: `full: true`, and it returns no resultId at
    // all, so Monaco would never have one to send anyway.
    const { monaco, registrations } = fakeMonaco();
    const { document, asked } = fakeDocument({ data: [0, 0, 1, 0, 0] });
    registerLspDocument(model, document);
    registerSemanticTokens(monaco, "typescript", LEGEND);

    await registrations[0]!.provider.provideDocumentSemanticTokens(model, "1", {} as never);

    expect(asked[0]!.method).toBe("textDocument/semanticTokens/full");
    unregisterLspDocument(model);
  });

  it("carries an edit with no data through, which means a pure deletion", async () => {
    const { monaco, registrations } = fakeMonaco();
    const { document } = fakeDocument(
      { edits: [{ start: 10, deleteCount: 5 }] },
      { semanticTokensProvider: { legend: LEGEND, full: { delta: true } } },
    );
    registerLspDocument(model, document);
    registerSemanticTokens(monaco, "typescript", LEGEND);

    const result = (await registrations[0]!.provider.provideDocumentSemanticTokens(model, "1", {} as never)) as {
      edits: Array<{ data?: Uint32Array }>;
    };

    expect(result.edits[0]!.data).toBeUndefined();
    unregisterLspDocument(model);
  });

  it("returns nothing for a model with no language server", async () => {
    const { monaco, registrations } = fakeMonaco();
    registerSemanticTokens(monaco, "typescript", LEGEND);

    const result = await registrations[0]!.provider.provideDocumentSemanticTokens(
      fakeModel("inmemory://model/99"),
      null,
      {} as never,
    );

    expect(result).toBeNull();
  });

  it("swallows a failed request rather than letting Monaco stop asking", async () => {
    const { monaco, registrations } = fakeMonaco();
    const { document } = fakeDocument(new Error("server died"));
    registerLspDocument(model, document);
    registerSemanticTokens(monaco, "typescript", LEGEND);

    expect(await registrations[0]!.provider.provideDocumentSemanticTokens(model, null, {} as never)).toBeNull();
    unregisterLspDocument(model);
  });
});
