import { expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

/** Keep Shiki and app-theme mocks out of the shared unit-test process. */
function runScenario(scenario: string): void {
  const result = Bun.spawnSync([process.execPath, "--eval", `
    import { mock } from "bun:test";
    import assert from "node:assert/strict";
    globalThis.window = new EventTarget();
    let applied = null;
    let creations = 0;
    const registeredThemes = new Set();
    function registerTheme(theme) {
      const name = typeof theme === "string" ? theme : theme.name;
      if (!name || name === "invalid-custom") throw new Error("Invalid theme");
      registeredThemes.add(name);
    }
    mock.module("shiki", () => ({ createHighlighter: async ({ themes }) => {
      creations++;
      themes.forEach(registerTheme);
      return {
        loadTheme: async (theme) => registerTheme(theme),
        loadLanguage: async () => {},
        codeToHtml: (code, { theme, lang }) => {
          assert.ok(registeredThemes.has(theme), "Rendering with an unregistered theme: " + theme);
          return JSON.stringify({ code, theme, lang });
        },
      };
    }}));
    mock.module("./src/web/theme/apply-theme", () => ({
      THEME_CHANGE_EVENT: "ppm:theme-change",
      getCurrentAppliedTheme: () => applied,
    }));
    const adapter = await import("./src/web/theme/adapters/shiki-adapter");
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
    const change = async (theme) => {
      applied = theme;
      window.dispatchEvent(new CustomEvent("ppm:theme-change", { detail: theme }));
      await flush();
    };
    ${scenario}
  `], { cwd: fileURLToPath(new URL("../../../", import.meta.url)), stdout: "pipe", stderr: "pipe" });
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
}

it("does not construct Shiki for subscriptions or theme changes; first highlight uses the latest built-in theme", () => {
  runScenario(`
    applied = { mode: "dark" };
    adapter.initShikiThemeSync();
    adapter.initShikiThemeSync();
    await change({ mode: "light" });
    assert.equal(creations, 0);
    assert.equal(adapter.highlightSync("const a = 1", "js"), null);
    assert.equal(creations, 0);
    const html = JSON.parse(await adapter.highlightToHtml("const a = 1", "js"));
    assert.equal(html.theme, "github-light");
    assert.equal(html.lang, "javascript");
    assert.equal(creations, 1);
    await change({ mode: "dark", syntax: { shikiTheme: "one-dark-pro" } });
    assert.equal(JSON.parse(adapter.highlightSync("const b = 2", "js")).theme, "one-dark-pro");
    assert.equal(creations, 1);
  `);
});

it("loads the selected custom theme before the first highlight and preserves synchronous highlighting", () => {
  runScenario(`
    applied = { mode: "dark", syntax: { shikiTheme: { name: "chosen-custom", tokenColors: [] } } };
    adapter.initShikiThemeSync();
    await flush();
    assert.equal(creations, 0);
    assert.equal(JSON.parse(await adapter.highlightToHtml("let x", "ts")).theme, "chosen-custom");
    assert.equal(JSON.parse(adapter.highlightSync("let y", "ts")).theme, "chosen-custom");
    assert.equal(creations, 1);
  `);
});

it("an invalid initial custom theme does not poison ordinary highlighting or later theme changes", () => {
  runScenario(`
    applied = { mode: "dark", syntax: { shikiTheme: { name: "invalid-custom" } } };
    adapter.initShikiThemeSync();
    await flush();
    assert.equal(creations, 0);
    const first = JSON.parse(await adapter.highlightToHtml("let x", "ts"));
    assert.equal(first.theme, "github-dark-dimmed");
    await change({ mode: "light" });
    assert.equal(JSON.parse(await adapter.highlightToHtml("let y", "ts")).theme, "github-light");
    await change({ mode: "dark", syntax: { shikiTheme: { name: "invalid-custom" } } });
    assert.equal(JSON.parse(adapter.highlightSync("let z", "ts")).theme, "github-light");
  `);
});
