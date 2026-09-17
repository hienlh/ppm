/**
 * The LSP-to-Monaco conversions, checked against Monaco's real enums.
 *
 * The enums come from `standaloneEnums.js`, which is plain data with no DOM
 * dependency, so these are the same numbers the browser will use. That matters:
 * the whole reason the tables map by name is that nobody can remember whether
 * Monaco's `Snippet` is 27 or 28, and a stub would just encode the same guess.
 */
import { describe, it, expect } from "bun:test";
import * as enums from "monaco-editor/esm/vs/editor/common/standalone/standaloneEnums.js";
import type * as MonacoType from "monaco-editor";
import {
  COMPLETION_KIND_NAMES,
  HIGHLIGHT_KIND_NAMES,
  SEVERITY_NAMES,
  SYMBOL_KIND_NAMES,
  completionKind,
  fromLspPosition,
  fromLspRange,
  highlightKind,
  markerSeverity,
  sortEditsBottomUp,
  symbolKind,
  toLspPosition,
  toLspRange,
  toMarkdown,
  toModelEdit,
} from "../../../src/web/lib/lsp/lsp-monaco.ts";

/** A monaco-shaped object carrying the real enum values. */
const monaco = {
  languages: {
    CompletionItemKind: (enums as Record<string, unknown>).CompletionItemKind,
    SymbolKind: (enums as Record<string, unknown>).SymbolKind,
    DocumentHighlightKind: (enums as Record<string, unknown>).DocumentHighlightKind,
  },
  MarkerSeverity: (enums as Record<string, unknown>).MarkerSeverity,
} as unknown as typeof MonacoType;

describe("positions", () => {
  it("shifts by exactly one in each direction", () => {
    // The bug this guards is silent: one off, and the server is asked about the
    // token beside the cursor and answers confidently about the wrong thing.
    expect(toLspPosition({ lineNumber: 1, column: 1 })).toEqual({ line: 0, character: 0 });
    expect(fromLspPosition({ line: 0, character: 0 })).toEqual({ lineNumber: 1, column: 1 });
  });

  it("round-trips every position", () => {
    for (const p of [{ lineNumber: 1, column: 1 }, { lineNumber: 42, column: 7 }, { lineNumber: 999, column: 120 }]) {
      expect(fromLspPosition(toLspPosition(p))).toEqual(p);
    }
  });

  it("round-trips a range", () => {
    const range = { startLineNumber: 3, startColumn: 5, endLineNumber: 3, endColumn: 11 };
    expect(fromLspRange(toLspRange(range))).toEqual(range);
  });

  it("converts a range that spans lines", () => {
    expect(fromLspRange({ start: { line: 0, character: 0 }, end: { line: 4, character: 2 } })).toEqual({
      startLineNumber: 1, startColumn: 1, endLineNumber: 5, endColumn: 3,
    });
  });
});

describe("kind tables", () => {
  it("covers every LSP completion kind with a name Monaco really has", () => {
    // 1..25 is the whole LSP range; a gap would show the wrong icon.
    for (let kind = 1; kind <= 25; kind++) {
      const name = COMPLETION_KIND_NAMES[kind];
      expect(name, `LSP completion kind ${kind}`).toBeDefined();
      expect(monaco.languages.CompletionItemKind[name!], `Monaco has ${name}`).toBeDefined();
    }
  });

  it("covers every LSP symbol kind with a name Monaco really has", () => {
    for (let kind = 1; kind <= 26; kind++) {
      const name = SYMBOL_KIND_NAMES[kind];
      expect(name, `LSP symbol kind ${kind}`).toBeDefined();
      expect(monaco.languages.SymbolKind[name!], `Monaco has ${name}`).toBeDefined();
    }
  });

  it("maps names, not numbers", () => {
    // LSP says Method is 2 and Text is 1; Monaco says Method is 0 and Text 18.
    // Passing the number through would put a Text icon on every method.
    expect(completionKind(monaco, 2)).toBe(monaco.languages.CompletionItemKind.Method);
    expect(completionKind(monaco, 1)).toBe(monaco.languages.CompletionItemKind.Text);
    expect(completionKind(monaco, 15)).toBe(monaco.languages.CompletionItemKind.Snippet);
    expect(completionKind(monaco, 2)).not.toBe(2 as unknown as number);
  });

  it("maps symbol kinds by name too", () => {
    expect(symbolKind(monaco, 1)).toBe(monaco.languages.SymbolKind.File);
    expect(symbolKind(monaco, 12)).toBe(monaco.languages.SymbolKind.Function);
    expect(symbolKind(monaco, 26)).toBe(monaco.languages.SymbolKind.TypeParameter);
  });

  it("inverts the severity scale correctly", () => {
    // LSP counts up from Error = 1; Monaco counts up to Error = 8. Passing the
    // number through would turn every error into a hint.
    expect(markerSeverity(monaco, 1)).toBe(monaco.MarkerSeverity.Error);
    expect(markerSeverity(monaco, 2)).toBe(monaco.MarkerSeverity.Warning);
    expect(markerSeverity(monaco, 3)).toBe(monaco.MarkerSeverity.Info);
    expect(markerSeverity(monaco, 4)).toBe(monaco.MarkerSeverity.Hint);
    expect(Object.keys(SEVERITY_NAMES)).toHaveLength(4);
  });

  it("maps highlight kinds", () => {
    expect(highlightKind(monaco, 2)).toBe(monaco.languages.DocumentHighlightKind.Read);
    expect(highlightKind(monaco, 3)).toBe(monaco.languages.DocumentHighlightKind.Write);
    expect(Object.keys(HIGHLIGHT_KIND_NAMES)).toHaveLength(3);
  });

  it("falls back rather than showing a wrong icon", () => {
    // A server may send a kind from a newer spec than this table knows.
    expect(completionKind(monaco, 99)).toBe(monaco.languages.CompletionItemKind.Text);
    expect(completionKind(monaco, undefined)).toBe(monaco.languages.CompletionItemKind.Text);
    expect(symbolKind(monaco, 99)).toBe(monaco.languages.SymbolKind.Variable);
    // An unspecified severity becomes a warning, not an error: a red squiggle
    // for something the server was unsure about is worse than a yellow one.
    expect(markerSeverity(monaco, undefined)).toBe(monaco.MarkerSeverity.Warning);
  });
});

describe("toMarkdown", () => {
  it("passes markdown through", () => {
    expect(toMarkdown({ kind: "markdown", value: "**bold**" })?.value).toBe("**bold**");
  });

  it("escapes a plain string so identifiers survive", () => {
    // `__init__` rendered as markdown loses the underscores and italicises the
    // middle, so the text the server sent is not the text shown.
    const out = toMarkdown("call __init__ or *args*")!.value;

    expect(out).not.toBe("call __init__ or *args*");
    expect(out).toContain("\\_\\_init\\_\\_");
  });

  it("escapes a plaintext MarkupContent as well", () => {
    expect(toMarkdown({ kind: "plaintext", value: "a_b" })?.value).toContain("a\\_b");
  });

  it("fences a MarkedString with its language", () => {
    expect(toMarkdown({ language: "typescript", value: "const a = 1" })?.value)
      .toBe("```typescript\nconst a = 1\n```");
  });

  it("joins an array with a rule, the way a hover stacks sections", () => {
    const out = toMarkdown([
      { language: "typescript", value: "function f(): void" },
      { kind: "markdown", value: "Does a thing." },
    ])!.value;

    expect(out).toBe("```typescript\nfunction f(): void\n```\n\n---\n\nDoes a thing.");
  });

  it("never trusts server markdown", () => {
    // Trusted markdown in Monaco can execute commands; this content came from
    // a doc comment in someone's dependency.
    expect(toMarkdown({ kind: "markdown", value: "x" })?.isTrusted).toBe(false);
  });

  it("returns nothing for absent or empty documentation", () => {
    expect(toMarkdown(null)).toBeUndefined();
    expect(toMarkdown(undefined)).toBeUndefined();
    expect(toMarkdown([])).toBeUndefined();
  });
});

describe("edits", () => {
  it("converts one edit", () => {
    expect(toModelEdit({
      range: { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } },
      newText: "const",
    })).toEqual({
      range: { startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 6 },
      text: "const",
    });
  });

  it("orders edits bottom-up so earlier offsets stay valid", () => {
    // Servers return edits against the original document in arbitrary order.
    // Applying top-down shifts every later position and scrambles the result.
    const edits = [
      { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } }, newText: "b" },
      { range: { start: { line: 9, character: 4 }, end: { line: 9, character: 5 } }, newText: "d" },
      { range: { start: { line: 1, character: 8 }, end: { line: 1, character: 9 } }, newText: "c" },
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "a" },
    ];

    expect(sortEditsBottomUp(edits).map((e) => e.newText)).toEqual(["d", "c", "b", "a"]);
  });

  it("does not mutate the array it was given", () => {
    const edits = [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "a" },
      { range: { start: { line: 5, character: 0 }, end: { line: 5, character: 1 } }, newText: "b" },
    ];

    sortEditsBottomUp(edits);

    expect(edits.map((e) => e.newText)).toEqual(["a", "b"]);
  });
});
