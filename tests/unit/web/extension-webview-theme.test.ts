import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  HOST_THEME_MESSAGE,
  hostThemeCss,
  injectHostTheme,
} from "../../../src/web/components/extensions/webview-theme";

/** Stand-in for the CSS vars apply-theme writes to <html>. */
function reader(vars: Record<string, string>) {
  return (name: string) => vars[name] ?? "";
}

const SLATE_DARK = {
  "--bg-solid": "#15161c",
  "--panel": "#1e2028",
  "--accent-wash": "rgba(91,124,250,0.13)",
  "--text": "#ecebe8",
  "--text-2": "#a6a49f",
  "--text-3": "#6f6d68",
  "--border": "#2b2e39",
  "--border-soft": "#23262f",
  "--accent": "#5b7cfa",
  "--success": "#3ecf8e",
  "--warning": "#f2a53c",
  "--error": "#f2555a",
};

describe("hostThemeCss", () => {
  it("maps the app's tokens onto the webview's palette", () => {
    const css = hostThemeCss(reader(SLATE_DARK));
    expect(css).toContain("--bg: #15161c;");
    expect(css).toContain("--surface: #1e2028;");
    expect(css).toContain("--text: #ecebe8;");
    expect(css).toContain("--subtext: #a6a49f;");
    expect(css).toContain("--selected: rgba(91,124,250,0.13);");
    expect(css).toContain("--blue: #5b7cfa;");
  });

  it("keeps the panels' two border tiers", () => {
    // The app's faint divider is the panels' hairline; its hairline is their
    // stronger one. Mapping both from --border would flatten every outline.
    const css = hostThemeCss(reader(SLATE_DARK));
    expect(css).toContain("--border: #23262f;");
    expect(css).toContain("--border2: #2b2e39;");
  });

  it("never injects the hover surface", () => {
    // Some app themes give --panel and --panel-2 the same colour, so a hover
    // mapped from either is invisible; the panels derive it from --text.
    const css = hostThemeCss(reader({ ...SLATE_DARK, "--panel-2": "#1e2028" }));
    expect(css).not.toContain("--surface-hover");
  });

  it("ties with the panels' own dark rule on specificity", () => {
    // One attribute selector, so being injected last is what wins. More
    // specific would be worse, not better: it would also beat a panel rule
    // that has a good reason to be more specific.
    expect(hostThemeCss(reader(SLATE_DARK)).startsWith(":root[data-ppm-theme] {")).toBe(true);
  });

  it("skips vars the document has no value for", () => {
    const css = hostThemeCss(reader({ "--bg-solid": "#fff" }));
    expect(css).toBe(":root[data-ppm-theme] { --bg: #fff; }");
  });

  it("emits nothing at all when no theme has been applied", () => {
    // Better an empty style element than a block of ":root { --bg: ; }", which
    // would resolve every var to its guaranteed-invalid initial value.
    expect(hostThemeCss(reader({}))).toBe("");
  });
});

describe("injectHostTheme", () => {
  const panel = '<!DOCTYPE html>\n<html>\n<head>\n<style>:root { --bg: #fff; }</style>\n</head>\n<body></body>\n</html>';

  it("stamps the mode on the panel's own html element", () => {
    const out = injectHostTheme(panel, { mode: "light", css: "" });
    expect(out).toContain('<html data-ppm-theme="light">');
  });

  it("keeps attributes the panel already had", () => {
    const out = injectHostTheme('<html lang="en"><head></head>', { mode: "dark", css: "" });
    expect(out).toContain('<html lang="en" data-ppm-theme="dark">');
  });

  it("puts the tokens after the panel's own stylesheet", () => {
    // Equal specificity, so source order decides — before the panel's <style>
    // the injected block would silently lose.
    const out = injectHostTheme(panel, { mode: "dark", css: ":root[data-ppm-theme] { --bg: #15161c; }" });
    expect(out.indexOf("ppm-theme-vars")).toBeGreaterThan(out.indexOf("--bg: #fff"));
    expect(out.indexOf("ppm-theme-vars")).toBeLessThan(out.indexOf("</head>"));
  });

  it("leaves a way to change the theme without reloading the panel", () => {
    const out = injectHostTheme(panel, { mode: "dark", css: "" });
    expect(out).toContain(HOST_THEME_MESSAGE);
    expect(out).toContain('getElementById("ppm-theme-vars")');
  });

  it("still lands the tokens on a panel with no head", () => {
    const out = injectHostTheme("<html><body>hi</body></html>", { mode: "dark", css: "x" });
    expect(out).toContain("ppm-theme-vars");
  });

  it("passes an empty panel through untouched", () => {
    expect(injectHostTheme("", { mode: "dark", css: "x" })).toBe("");
  });
});

describe("ExtensionWebview theme wiring", () => {
  const source = readFileSync(
    resolve(import.meta.dir, "../../../src/web/components/extensions/extension-webview.tsx"),
    "utf8",
  );

  it("seeds the theme into srcDoc without making srcDoc depend on it", () => {
    // srcDoc is what mounts the iframe. Adding the theme to this dependency
    // array — which is what silencing the exhaustive-deps warning looks like —
    // reloads the panel on every theme change: a graph refetches every commit
    // and loses its scroll position because the user flipped to light.
    const memo = source.slice(source.indexOf("const html = useMemo("));
    const deps = memo.slice(0, memo.indexOf("\n  );"));
    expect(deps).toContain("injectHostTheme");
    expect(deps.trimEnd().endsWith("[rawHtml],")).toBe(true);
  });

  it("forwards later theme changes into the iframe instead", () => {
    expect(source).toContain("THEME_CHANGE_EVENT");
    expect(source).toContain("command: HOST_THEME_MESSAGE");
  });
});
