import { describe, it, expect } from "bun:test";
import { SHELL_CSS, FONT_TOKENS } from "./webview-shell.ts";

describe("SHELL_CSS theme source", () => {
  it("takes dark from the host attribute, not only from the OS", () => {
    // The five shell panels are sandboxed iframes, so prefers-color-scheme
    // reports the desktop's setting, not the theme the app is on.
    expect(SHELL_CSS).toContain(':root[data-ppm-theme="dark"]');
  });

  it("never lets the OS media query override an explicit light", () => {
    const media = SHELL_CSS.slice(SHELL_CSS.indexOf("@media (prefers-color-scheme: dark)"));
    expect(media).toContain(':root:not([data-ppm-theme="light"])');
  });

  it("derives the hover surface from the text colour", () => {
    // Mapping it from an app token would make it invisible in the themes that
    // give both panel surfaces the same colour.
    expect(SHELL_CSS).toContain("--surface-hover: color-mix(in srgb, var(--text)");
  });

  it("keeps the same dark values as the graph panel", async () => {
    // The two stylesheets are separate strings; the shell's own doc comment
    // claims they match, and a panel opened from the graph sits next to it.
    const { getWebviewHtml } = await import("./webview-html.ts");
    const graph = getWebviewHtml();
    const darkBlock = SHELL_CSS.slice(
      SHELL_CSS.indexOf(':root[data-ppm-theme="dark"] {'),
      SHELL_CSS.indexOf("@media (prefers-color-scheme: dark)"),
    );
    for (const decl of darkBlock.split(";").map((d) => d.trim()).filter((d) => d.startsWith("--"))) {
      expect(graph).toContain(decl);
    }
  });
  it("asks for the app's typefaces by name, and one stack for every panel", () => {
    // A panel is a sandboxed iframe with an opaque origin, so it cannot use the
    // faces the app bundles: a @font-face pointing at /assets/ is a cross-origin
    // fetch, and the file name carries Vite's content hash the extension has no
    // way to know. Asking by name is what makes a panel match the app on a host
    // where the fonts are installed — and the fallbacks matter for the host
    // where they are not, because a bare sans-serif can resolve to a *serif*.
    expect(FONT_TOKENS).toContain("--ui-font: 'Geist', system-ui");
    expect(FONT_TOKENS).toContain("--mono-font: 'Monaspace Argon', 'Monaspace Argon Var'");
    expect(FONT_TOKENS).toContain("sans-serif;");
    expect(FONT_TOKENS).toContain("monospace;");
    // Defined once and interpolated into both stylesheets. Two copies of a
    // stack is how the graph and the panels opened from it came to disagree
    // about their colours before.
    expect(SHELL_CSS).toContain(FONT_TOKENS.trim());
  });

  it("leaves no literal font stack behind in either stylesheet", async () => {
    const { getWebviewHtml } = await import("./webview-html.ts");
    // Only as a *declaration*: those families are legitimate fallbacks inside
    // the token values themselves.
    for (const sheet of [SHELL_CSS, getWebviewHtml()]) {
      const declared = [...sheet.matchAll(/font-family:\s*([^;]+);/g)].map((m) => m[1].trim());
      for (const value of declared) {
        expect(["var(--ui-font)", "var(--mono-font)", "inherit"]).toContain(value);
      }
    }
  });
});
