/**
 * @monaco-editor/react reads `onMount` from an editor's first render and never again. A Query tab
 * whose tables arrived after that render but before Monaco had mounted registered completion
 * nowhere: the `onMount` it was handed had seen no schema, and the effect that saw the schema ran
 * while there was no editor yet. So a second Query tab — opened once Monaco was loaded and mounted
 * fast — offered no table at all. The fake below keeps the library's first-render `onMount` and
 * mounts when the test says, which is how both orders are put to the editor.
 */
import { expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

it("registers completion whichever of the schema and the editor comes first, and removes it with the editor", () => {
  // Module mocks stay in a child process so other browser suites keep the real Monaco wrapper.
  const result = Bun.spawnSync([process.execPath, "--eval", `
    import { mock } from "bun:test";
    import assert from "node:assert/strict";
    import { installDom } from "./tests/helpers/react-dom.tsx";
    installDom();
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const React = await import("react");
    const { act } = React;

    const text = "SELECT * FROM ";
    const model = {
      getValue: () => text,
      getValueInRange: (r) => text.slice(0, r.endColumn - 1),
      getWordUntilPosition: (p) => ({ word: "", startColumn: p.column, endColumn: p.column }),
    };
    const editor = { addAction() {}, getAction: () => null, getModel: () => model };
    const live = [];
    const monaco = {
      KeyMod: { CtrlCmd: 2048 }, KeyCode: { Enter: 3 },
      languages: {
        CompletionItemKind: { Field: 3, Keyword: 17, Operator: 11, Struct: 22, Value: 12, Function: 1 },
        CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
        registerCompletionItemProvider(language, provider) {
          const entry = { language, provider };
          live.push(entry);
          return { dispose() { const i = live.indexOf(entry); if (i >= 0) live.splice(i, 1); } };
        },
      },
    };
    const pendingMounts = [];
    mock.module("@monaco-editor/react", () => ({
      loader: { config() {}, init: () => new Promise(() => {}) },
      default: function Editor(props) {
        const onMount = React.useRef(props.onMount);
        React.useEffect(() => { pendingMounts.push(() => onMount.current(editor, monaco)); }, []);
        return null;
      },
    }));
    const { SqlQueryEditor } = await import("./src/web/components/database/sql-query-editor.tsx");
    const { createRoot } = await import("react-dom/client");

    const schema = (name) => ({ tables: [{ name, schema: "public" }], getColumns: async () => [] });
    const offered = () => Promise.all(live.map(async ({ language, provider }) => {
      const list = await provider.provideCompletionItems(model, { lineNumber: 1, column: text.length + 1 });
      return language + ":" + list.suggestions.map((s) => s.label).join(",");
    }));
    const view = (schemaInfo) => React.createElement(SqlQueryEditor, { onExecute() {}, loading: false, schemaInfo });
    const mountEditor = () => act(async () => pendingMounts.shift()());

    // The tables arrive between the first render and the editor.
    const first = createRoot(document.createElement("div"));
    await act(async () => first.render(view(undefined)));
    await act(async () => first.render(view(schema("users"))));
    assert.deepEqual(await offered(), []);
    await mountEditor();
    assert.deepEqual(await offered(), ["sql:users"]);
    await act(async () => first.unmount());
    assert.deepEqual(live, []);

    // The editor is up before the tables are.
    const second = createRoot(document.createElement("div"));
    await act(async () => second.render(view(undefined)));
    await mountEditor();
    assert.deepEqual(await offered(), []);
    await act(async () => second.render(view(schema("users"))));
    assert.deepEqual(await offered(), ["sql:users"]);
    // Refreshed tables replace the provider rather than adding a second.
    await act(async () => second.render(view(schema("orders"))));
    assert.deepEqual(await offered(), ["sql:orders"]);
    await act(async () => second.unmount());
    assert.deepEqual(live, []);
  `], { cwd: fileURLToPath(new URL("../../../", import.meta.url)), stdout: "pipe", stderr: "pipe", env: { ...process.env } });
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
});
