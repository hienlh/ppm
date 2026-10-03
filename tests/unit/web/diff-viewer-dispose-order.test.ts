/**
 * `@monaco-editor/react` 4.7 disposes a diff's two models on unmount before the diff editor
 * still showing them, which Monaco 0.55 reports as "TextModel got disposed before
 * DiffEditorWidget model got reset" — an uncaught error on every closed diff. The viewer's
 * wrapper detaches and disposes them first. This mounts the real viewer over the real library,
 * with only Monaco itself faked, and closes it.
 */
import { expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

it("closes a diff without disposing a model the diff editor still shows", () => {
  // Module mocks stay in a child process so other suites keep the real Monaco loader.
  const result = Bun.spawnSync([process.execPath, "--eval", `
    import { mock } from "bun:test";
    import { installDom, installGlobal } from "./tests/helpers/react-dom";
    installDom();
    // happy-dom lays nothing out, so its own observer never reports a size.
    installGlobal("ResizeObserver", class {
      constructor(callback) { this.callback = callback; }
      observe() { this.callback([{ contentRect: { width: 800, height: 480 } }]); }
      disconnect() {}
    });
    const report = { mounted: false, disposedWhileShown: 0, editorDisposed: false, modelsDisposed: 0 };
    // What Monaco 0.55 does: a model disposed while a diff editor still holds it is a bug.
    class Model {
      constructor(value) { this.value = value; this.shownBy = null; }
      dispose() { if (this.shownBy) report.disposedWhileShown++; report.modelsDisposed++; }
      getValue() { return this.value; }
      setValue(value) { this.value = value; }
    }
    const pane = () => ({ updateOptions() {}, onDidFocusEditorText() { return { dispose() {} }; }, getOption() { return true; } });
    class DiffEditor {
      model = null; original = pane(); modified = pane();
      setModel(model) {
        if (this.model) { this.model.original.shownBy = null; this.model.modified.shownBy = null; }
        this.model = model;
        if (model) { model.original.shownBy = this; model.modified.shownBy = this; }
      }
      getModel() { return this.model; }
      getOriginalEditor() { return this.original; }
      getModifiedEditor() { return this.modified; }
      updateOptions() {} addCommand() {} layout() {}
      dispose() { report.editorDisposed = true; this.setModel(null); }
    }
    let shown = null;
    const monaco = {
      editor: {
        createDiffEditor: () => (shown = new DiffEditor()),
        createModel: (value) => new Model(value),
        getModel: () => null,
        setTheme() {}, defineTheme() {}, setModelLanguage() {},
        EditorOption: { readOnly: 90 },
      },
      languages: { getLanguages: () => [], register() {}, setLanguageConfiguration() {}, setMonarchTokensProvider() {} },
      Uri: { parse: (value) => ({ toString: () => value }) },
      KeyMod: { Alt: 512 }, KeyCode: { KeyB: 32 },
    };
    const init = () => Object.assign(Promise.resolve(monaco), { cancel() {} });
    mock.module("@monaco-editor/loader", () => ({ default: { init, config() {}, __getMonacoInstance: () => monaco } }));

    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { DiffViewer } = await import("./src/web/components/editor/diff-viewer");
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await React.act(async () => {
      root.render(React.createElement(DiffViewer, { metadata: { original: "const a = 1;\\n", modified: "const a = 2;\\n" } }));
    });
    await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    // The library created the editor and gave it both models: the close below has them to dispose.
    report.mounted = Boolean(shown?.getModel()?.original && shown.getModel().modified);
    await React.act(async () => { root.unmount(); });
    console.log(JSON.stringify(report));
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
  const report = JSON.parse(lines[lines.length - 1]!);
  expect(report).toEqual({ mounted: true, disposedWhileShown: 0, editorDisposed: true, modelsDisposed: 2 });
});
