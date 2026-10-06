/**
 * Monaco keeps completion providers per language, so every mounted SQL editor's provider is asked
 * about every SQL model on the page. Each answers only for its own editor — or a Query tab on one
 * connection offers another connection's tables — and no cache hands one connection's columns to
 * another because both have a table of that name.
 */
import { describe, expect, it } from "bun:test";
import type * as MonacoType from "monaco-editor";
import { createSqlCompletionProvider, type SchemaInfo } from "../../../src/web/components/database/sql-completion-provider";

const monaco = {
  languages: {
    CompletionItemKind: { Field: 3, Keyword: 17, Operator: 11, Struct: 22, Value: 12, Function: 1 },
    CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
  },
} as unknown as typeof MonacoType;

type Model = MonacoType.editor.ITextModel;

/** A one-line document, asked about with the cursor at its end. */
function model(text: string): Model {
  return {
    getValue: () => text,
    getValueInRange: (r: MonacoType.IRange) => text.slice(0, r.endColumn - 1),
    getWordUntilPosition: (p: MonacoType.Position) => {
      const word = /\w*$/.exec(text.slice(0, p.column - 1))![0];
      return { word, startColumn: p.column - word.length, endColumn: p.column };
    },
  } as unknown as Model;
}

function schema(tables: string[], columns: Record<string, string[]> = {}, onFetch = () => {}): SchemaInfo {
  return {
    tables: tables.map((name) => ({ name, schema: "public" })),
    getColumns: async (table) => {
      onFetch();
      return (columns[table] ?? []).map((name) => ({ name, type: "text" }));
    },
  };
}

const editorOf = (m: Model | null) => ({ getModel: () => m });

async function labels(provider: MonacoType.languages.CompletionItemProvider, m: Model): Promise<string[]> {
  const position = { lineNumber: 1, column: m.getValue().length + 1 } as MonacoType.Position;
  const list = await provider.provideCompletionItems(m, position, {} as never, {} as never);
  return (list?.suggestions ?? []).map((s) => String(s.label));
}

describe("which editor a provider answers for", () => {
  it("offers its tables in its own editor and nothing in another's", async () => {
    const pgModel = model("SELECT * FROM ");
    const fileModel = model("SELECT * FROM ");
    const pg = createSqlCompletionProvider(monaco, schema(["order_items"]), () => "postgres", editorOf(pgModel));
    const file = createSqlCompletionProvider(monaco, schema(["items", "tags"]), () => "sqlite", editorOf(fileModel));

    expect(await labels(file, fileModel)).toEqual(["items", "tags"]);
    expect(await labels(pg, fileModel)).toEqual([]);
    expect(await labels(pg, pgModel)).toEqual(["order_items"]);
    expect(await labels(file, pgModel)).toEqual([]);
  });

  it("asks its editor on every request, so one whose editor is gone never answers", async () => {
    const m = model("SELECT * FROM ");
    let current: Model | null = m;
    const provider = createSqlCompletionProvider(monaco, schema(["users"]), () => "postgres", { getModel: () => current });
    expect(await labels(provider, m)).toEqual(["users"]);
    current = null;
    expect(await labels(provider, m)).toEqual([]);
  });
});

describe("the columns it has fetched", () => {
  const text = "SELECT * FROM users u WHERE u.";

  it("stay with their schema, though another connection has a table of the same name", async () => {
    const a = model(text);
    const b = model(text);
    const pg = createSqlCompletionProvider(monaco, schema(["users"], { users: ["email"] }), () => "postgres", editorOf(a));
    const my = createSqlCompletionProvider(monaco, schema(["users"], { users: ["login"] }), () => "mysql", editorOf(b));
    expect(await labels(pg, a)).toEqual(["email"]);
    expect(await labels(my, b)).toEqual(["login"]);
  });

  it("are fetched once per schema, and again for the schema that replaces it", async () => {
    const m = model(text);
    let fetched = 0;
    const first = createSqlCompletionProvider(monaco, schema(["users"], { users: ["email"] }, () => fetched++), () => "postgres", editorOf(m));
    await labels(first, m);
    expect(await labels(first, m)).toEqual(["email"]);
    expect(fetched).toBe(1);

    // A refreshed schema is a new object, and a column added since is offered.
    const refreshed = createSqlCompletionProvider(monaco, schema(["users"], { users: ["email", "phone"] }, () => fetched++), () => "postgres", editorOf(m));
    expect(await labels(refreshed, m)).toEqual(["email", "phone"]);
    expect(fetched).toBe(2);
  });
});
