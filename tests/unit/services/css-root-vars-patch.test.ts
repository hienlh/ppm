import { describe, expect, it } from "bun:test";
import {
  appendRootBlock, findRootVarDeclarations, replaceValue, scanRootVars,
} from "../../../src/services/design/source/css-root-vars-patch.ts";

const valueOf = (css: string, name: string) =>
  findRootVarDeclarations(css).filter((d) => d.var === name).map((d) => css.slice(d.valueStart, d.valueEnd));

/** The one contiguous region where two strings differ. */
function diffRegion(a: string, b: string): { prefix: number; suffix: number } {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  return { prefix, suffix };
}

describe("findRootVarDeclarations", () => {
  it("finds :root and html declarations in order, with trimmed value offsets", () => {
    const css = ":root {\n  --accent:  #123456 ;\n  color: red;\n}\nhtml{--radius:4px}\n:root { --accent: #abcdef }";
    expect(valueOf(css, "--accent")).toEqual(["#123456", "#abcdef"]);
    expect(valueOf(css, "--radius")).toEqual(["4px"]);
    expect(findRootVarDeclarations(css).every((d) => d.exclusive && !d.conditional)).toBe(true);
  });

  it("marks declarations inside at-rules conditional and skips non-grouping at-rules", () => {
    const css = "@media (prefers-color-scheme: dark) { :root { --bg: #000 } }\n@supports (x: y) { html { --bg: #111 } }\n"
      + "@font-face { font-family: x; --bg: #222 }\n@layer base { :root { --bg: #333 } }\n:root { --bg: #fff }";
    const found = findRootVarDeclarations(css);
    expect(found.map((d) => [css.slice(d.valueStart, d.valueEnd), d.conditional, d.atRule])).toEqual([
      ["#000", true, "@media"], ["#111", true, "@supports"], ["#333", true, "@layer"], ["#fff", false, null],
    ]);
  });

  it("is not fooled by comments, strings or unquoted url() holding :root{", () => {
    const css = "/* :root { --x: 1px } */\n.a::before { content: ':root { --x: 2px }'; }\n"
      + ".b { background: url(data:image/svg+xml;utf8,<svg>{}</svg>) }\n:root { --x: 3px /* trailing */ ; --y: \"a;b\" }";
    expect(valueOf(css, "--x")).toEqual(["3px"]);
    expect(valueOf(css, "--y")).toEqual(['"a;b"']);
  });

  it("tells exclusive selectors from lists and ignores other selectors and nested rules", () => {
    const css = ":root, .dark { --x: 1px }\nbody { --x: 2px }\n:root { &.a { --x: 5px } --z: 1 }\n:is(:root, .a) { --x: 4px }";
    const found = findRootVarDeclarations(css);
    expect(found.map((d) => [d.var, css.slice(d.valueStart, d.valueEnd), d.exclusive])).toEqual([
      ["--x", "1px", false], ["--z", "1", true],
    ]);
  });

  it("reports !important and excludes it from the value", () => {
    const [d] = findRootVarDeclarations(":root { --x: 4px !important; }");
    expect(d).toMatchObject({ important: true });
    expect(":root { --x: 4px !important; }".slice(d!.valueStart, d!.valueEnd)).toBe("4px");
  });

  it("gives an empty value a zero-width slot right after the colon", () => {
    const css = ":root{--x:;}";
    const [d] = findRootVarDeclarations(css);
    expect(replaceValue(css, d!, "1px")).toBe(":root{--x:1px;}");
  });

  it("knows when the text does not end cleanly", () => {
    expect(scanRootVars(":root { --x: 1px }").endsClean).toBe(true);
    for (const css of [":root { --x: 1px }\n/* open", "a { color: red", "a { content: 'x", "div", "@import 'x.css'", "a { b: url(x"]) {
      expect(scanRootVars(css).endsClean).toBe(false);
      expect(appendRootBlock(css, [["--x", "1px"]])).toBeNull();
    }
  });
});

describe("replaceValue / appendRootBlock", () => {
  const css = "/* theme */\n:root {\n  --accent: #111111;\n  --radius: 4px;\n}\n\n.card { border-radius: var(--radius); }\n";

  it("changes only the targeted value (byte diff) and is idempotent", () => {
    const [accent] = findRootVarDeclarations(css).filter((d) => d.var === "--accent");
    const once = replaceValue(css, accent!, "#6366f1");
    expect(once).toBe(css.slice(0, accent!.valueStart) + "#6366f1" + css.slice(accent!.valueEnd));
    // Every byte that differs lies inside the old value's span.
    const { prefix, suffix } = diffRegion(css, once);
    expect(prefix).toBeGreaterThanOrEqual(accent!.valueStart);
    expect(css.length - suffix).toBeLessThanOrEqual(accent!.valueEnd);
    const [again] = findRootVarDeclarations(once).filter((d) => d.var === "--accent");
    expect(replaceValue(once, again!, "#6366f1")).toBe(once);
  });

  it("appends after the last rule, never before it, keeping the file's line endings", () => {
    const out = appendRootBlock(css, [["--gap", "8px"], ["--font", "Georgia, serif"]])!;
    expect(out.startsWith(css.trimEnd())).toBe(true);
    expect(out.slice(css.trimEnd().length)).toBe("\n\n:root {\n  --gap: 8px;\n  --font: Georgia, serif;\n}\n");
    const crlf = appendRootBlock("a{}\r\n", [["--x", "1px"]])!;
    expect(crlf).toBe("a{}\r\n\r\n:root {\r\n  --x: 1px;\r\n}\r\n");
    expect(appendRootBlock("", [["--x", "1px"]])).toBe(":root {\n  --x: 1px;\n}\n");
    const vars = findRootVarDeclarations(out).map((d) => d.var);
    expect(vars).toEqual(["--accent", "--radius", "--gap", "--font"]);
  });

  it("keeps an inline block's trailing indentation after the appended block", () => {
    expect(appendRootBlock("\n    a { }\n  ", [["--x", "1px"]])).toBe("\n    a { }\n\n:root {\n  --x: 1px;\n}\n  ");
  });
});
