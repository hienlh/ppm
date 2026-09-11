/**
 * URI translation between the browser's Monaco models and the language server.
 *
 * PPM mounts its editors with a value and no path, so Monaco names its models
 * `inmemory://model/N`. A language server has never heard of that name, and the
 * `file:` URIs it answers with match no model. Neither side can use the other's
 * name, so every request and every response passes through here.
 *
 * Getting it wrong is silent in both directions: unrewritten requests make the
 * server answer about a document it was never given, and unrewritten responses
 * make Monaco treat the open file as a different one — so "go to definition"
 * inside the current file tries to open an editor for it instead of jumping,
 * and diagnostics attach to no model and simply never appear.
 */
import { describe, it, expect } from "bun:test";
import { rewriteUris, withDocumentUri } from "../../../src/server/ws/lsp.ts";
import { pathToFileUri } from "../../../src/shared/lsp-uri.ts";

const FILE = "/home/ada/repo/src/app.ts";
const FILE_URI = pathToFileUri(FILE);
const MODEL_URI = "inmemory://model/1";
const map = new Map([[FILE.replace(/\\/g, "/"), MODEL_URI]]);

describe("withDocumentUri", () => {
  it("replaces the document uri the browser sent", () => {
    const out = withDocumentUri(
      { textDocument: { uri: MODEL_URI }, position: { line: 3, character: 7 } },
      FILE_URI,
    );

    expect(out).toEqual({ textDocument: { uri: FILE_URI }, position: { line: 3, character: 7 } });
  });

  it("leaves the rest of the params alone", () => {
    const out = withDocumentUri(
      { textDocument: { uri: MODEL_URI, version: 4 }, context: { includeDeclaration: true } },
      FILE_URI,
    ) as Record<string, unknown>;

    expect(out.context).toEqual({ includeDeclaration: true });
    expect(out.textDocument).toEqual({ uri: FILE_URI, version: 4 });
  });

  it("passes through params that carry no document", () => {
    expect(withDocumentUri({ command: "x" }, FILE_URI)).toEqual({ command: "x" });
    expect(withDocumentUri(null, FILE_URI)).toBeNull();
  });
});

describe("rewriteUris", () => {
  it("rewrites a location in the open file back to the model", () => {
    // Left as a file: URI, Monaco decides its own file is somewhere else and
    // opens an editor rather than jumping.
    const out = rewriteUris(
      [{ uri: FILE_URI, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } } }],
      map,
    );

    expect((out as Array<{ uri: string }>)[0]!.uri).toBe(MODEL_URI);
  });

  it("rewrites a LocationLink's targetUri", () => {
    const out = rewriteUris([{ targetUri: FILE_URI, targetRange: {} }], map) as Array<{ targetUri: string }>;

    expect(out[0]!.targetUri).toBe(MODEL_URI);
  });

  it("rewrites the uri a diagnostics notification names", () => {
    const out = rewriteUris({ uri: FILE_URI, diagnostics: [{ message: "bad" }] }, map) as { uri: string };

    expect(out.uri).toBe(MODEL_URI);
  });

  it("rewrites the keys of a workspace edit's changes", () => {
    // These are URIs used as object keys, which a value-only walk would miss —
    // and a rename would then edit a file Monaco cannot find.
    const out = rewriteUris(
      { changes: { [FILE_URI]: [{ range: {}, newText: "x" }] } },
      map,
    ) as { changes: Record<string, unknown> };

    expect(Object.keys(out.changes)).toEqual([MODEL_URI]);
  });

  it("rewrites nested documentChanges", () => {
    const out = rewriteUris(
      { documentChanges: [{ textDocument: { uri: FILE_URI, version: 2 }, edits: [] }] },
      map,
    ) as { documentChanges: Array<{ textDocument: { uri: string } }> };

    expect(out.documentChanges[0]!.textDocument.uri).toBe(MODEL_URI);
  });

  it("leaves a file the browser does not have open as a file: URI", () => {
    // The browser turns this into a path and opens a tab for it, so rewriting
    // it to anything else would break cross-file navigation.
    const other = pathToFileUri("/home/ada/repo/src/other.ts");
    const out = rewriteUris([{ uri: other, range: {} }], map) as Array<{ uri: string }>;

    expect(out[0]!.uri).toBe(other);
  });

  it("matches a URI the server spelled differently", () => {
    // Servers do not always echo a URI back byte for byte; an unescaped space
    // or a different escape casing names the same file.
    const spaced = new Map([["/home/ada/repo/my dir/app.ts", MODEL_URI]]);

    const out = rewriteUris([{ uri: "file:///home/ada/repo/my%20dir/app.ts", range: {} }], spaced) as Array<{ uri: string }>;

    expect(out[0]!.uri).toBe(MODEL_URI);
  });

  it("does nothing when no documents are open", () => {
    const payload = [{ uri: FILE_URI, range: {} }];

    expect(rewriteUris(payload, new Map())).toBe(payload);
  });

  it("preserves everything that is not a uri", () => {
    const out = rewriteUris(
      { uri: FILE_URI, diagnostics: [{ message: "bad", severity: 1, code: "TS2322", source: "ts" }] },
      map,
    );

    expect(out).toEqual({
      uri: MODEL_URI,
      diagnostics: [{ message: "bad", severity: 1, code: "TS2322", source: "ts" }],
    });
  });

  it("survives nulls and primitives in the tree", () => {
    expect(rewriteUris({ a: null, b: 1, c: "x", d: [null, 2] }, map))
      .toEqual({ a: null, b: 1, c: "x", d: [null, 2] });
  });
});
