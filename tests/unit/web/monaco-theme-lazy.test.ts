import { expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

it("keeps boot and theme changes lazy, then themes editors synchronously and stays in sync", () => {
  // Module mocks stay in a child process so other browser suites keep real stores.
  const result = Bun.spawnSync([process.execPath, "--eval", `
    import { mock } from "bun:test";
    import assert from "node:assert/strict";
    import { BUILTIN_THEMES } from "./src/web/theme/builtin";
    const calls = [];
    let initCalls = 0;
    let applied = null;
    globalThis.window = new EventTarget();
    mock.module("@monaco-editor/react", () => ({ loader: {
      config: (value) => assert.equal(value.paths.vs, "/assets/monaco/vs"),
      init: () => { initCalls++; throw new Error("Theme adapter must never load Monaco"); },
    }}));
    mock.module("@/stores/settings-store", () => ({ useSettingsStore: {
      getState: () => ({ themeStyle: "aurora", themeMode: "dark", customThemes: [] }),
    }}));
    mock.module("./src/web/theme/apply-theme", () => ({
      THEME_CHANGE_EVENT: "ppm:theme-change",
      getCurrentAppliedTheme: () => applied,
    }));
    const { initMonacoThemeSync, prepareMonacoTheme } = await import("./src/web/theme/adapters/monaco-adapter");
    const change = () => window.dispatchEvent(new Event("ppm:theme-change"));
    initMonacoThemeSync();
    initMonacoThemeSync();
    applied = BUILTIN_THEMES["slate-light"];
    change();
    await Promise.resolve();
    assert.equal(initCalls, 0);
    assert.equal(calls.length, 0);
    const monaco = { editor: {
      defineTheme: (name, data) => calls.push({ kind: "define", name, data }),
      setTheme: (name) => calls.push({ kind: "set", name }),
    }};
    prepareMonacoTheme(monaco);
    assert.equal(calls.length, 2); // beforeMount must finish before editor creation
    assert.equal(calls[0].name, "ppm-slate-light");
    assert.equal(calls[0].data.base, "vs");
    assert.equal(calls[0].data.colors["editor.background"], applied.tokens.bgSolid);
    assert.equal(calls[1].name, "ppm-slate-light");
    applied = { ...BUILTIN_THEMES["aurora-dark"], id: "custom-dark", editor: {
      colors: { "editor.background": "#123456" },
      rules: [{ token: "custom", foreground: "abcdef" }],
    }};
    change();
    assert.equal(calls.length, 4); // repeated init does not duplicate listeners
    assert.equal(calls[2].name, "ppm-custom-dark");
    assert.equal(calls[2].data.base, "vs-dark");
    assert.equal(calls[2].data.colors["editor.background"], "#123456");
    assert.deepEqual(calls[2].data.rules.at(-1), applied.editor.rules[0]);
    assert.equal(calls[3].name, "ppm-custom-dark");
    prepareMonacoTheme(monaco); // opening a diff viewer keeps the active custom theme
    assert.equal(calls[5].name, "ppm-custom-dark");
    applied = null; // settings fallback before the app has applied a theme
    prepareMonacoTheme(monaco);
    assert.equal(calls[7].name, "ppm-aurora-dark");
    assert.equal(initCalls, 0);
  `], { cwd: fileURLToPath(new URL("../../../", import.meta.url)), stdout: "pipe", stderr: "pipe" });
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
});
