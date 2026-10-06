import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  FILE_ICONS_COMMAND,
  fileIconsAnswer,
  fileIconsRequest,
  indexIconRules,
  type IconRule,
} from "../../../src/web/components/extensions/webview-file-icons";
import { fileIconName } from "../../../src/web/lib/file-icon-name";

const rule = (selectorText: string, backgroundImage: string): IconRule => ({ selectorText, style: { backgroundImage } });

/**
 * The real stylesheet's rules, the way the browser's CSSOM hands them over: one
 * selector and one `background-image` each. A selector the index failed to
 * recognise here is an icon every panel would draw blank.
 */
function generatedRules(): IconRule[] {
  // A Windows checkout with core.autocrlf has CRLF line endings.
  const css = readFileSync(resolve(import.meta.dir, "../../../src/web/styles/file-icons.generated.css"), "utf8").replace(/\r\n/g, "\n");
  return [...css.matchAll(/^([^\n{]+) \{\n {2}background-image: (.*);\n\}$/gm)].map((m) => rule(m[1]!, m[2]!));
}

describe("a webview asking the app for file icons", () => {
  test("any other message is the extension's, untouched", () => {
    expect(fileIconsRequest({ command: "ready" })).toBeUndefined();
    expect(fileIconsRequest("hello")).toBeUndefined();
    expect(fileIconsRequest(null)).toBeUndefined();
  });

  test("only string names are read, and only so many", () => {
    expect(fileIconsRequest({ command: FILE_ICONS_COMMAND, names: ["a.ts", 4, null, { a: 1 }, "b.md"] })).toEqual(["a.ts", "b.md"]);
    expect(fileIconsRequest({ command: FILE_ICONS_COMMAND, names: "a.ts" })).toEqual([]);
    expect(fileIconsRequest({ command: FILE_ICONS_COMMAND, names: Array.from({ length: 2000 }, (_, i) => `f${i}.ts`) })).toHaveLength(500);
  });
});

describe("the answer", () => {
  const index = indexIconRules([
    rule(".vsi-file-type-json", 'url("data:dark-json")'),
    rule(":root.light .vsi-file-type-json", 'url("data:light-json")'),
    rule(".vsi-file-type-typescript", 'url("data:ts")'),
    rule(".unrelated", 'url("data:x")'),
    { cssText: "@media print {}" },
  ]);

  test("names each file's class the way the app's own trees resolve it", () => {
    const names = ["a.ts", "package.json", "Dockerfile", "__proto__"];
    const answer = fileIconsAnswer(names, null, index);
    expect(answer.command).toBe(FILE_ICONS_COMMAND);
    expect(answer.icons).toEqual(names.map((n) => [n, `vsi-${fileIconName(n, null)}`]));
  });

  test("follows the project's framework, as FileIcon does", () => {
    const [[, nest]] = fileIconsAnswer(["app.service.ts"], "nest", index).icons;
    const [[, plain]] = fileIconsAnswer(["app.service.ts"], null, index).icons;
    expect(nest).toBe(`vsi-${fileIconName("app.service.ts", "nest")}`);
    expect(nest).not.toBe(plain);
  });

  test("carries each drawing once, and the light one keyed on the panel's own theme attribute", () => {
    const answer = fileIconsAnswer(["a.json", "b.json", "c.ts"], null, index);
    expect(answer.rules).toEqual([
      [
        "vsi-file-type-json",
        '.vsi-file-type-json { background-image: url("data:dark-json"); }\n'
          + ':root[data-ppm-theme="light"] .vsi-file-type-json { background-image: url("data:light-json"); }\n',
      ],
      ["vsi-file-type-typescript", '.vsi-file-type-typescript { background-image: url("data:ts"); }\n'],
    ]);
  });

  test("still names a class whose drawing it does not have", () => {
    const answer = fileIconsAnswer(["a.ts"], null, new Map());
    expect(answer.icons).toEqual([["a.ts", "vsi-file-type-typescript"]]);
    expect(answer.rules).toEqual([]);
  });

  test("finds a drawing in the real stylesheet for every class, both themes where it has two", () => {
    const rules = generatedRules();
    expect(rules.length).toBeGreaterThan(1000);
    const real = indexIconRules(rules);
    // Every rule in the file is one the index understood.
    expect([...real.values()].reduce((n, e) => n + (e.dark ? 1 : 0) + (e.light ? 1 : 0), 0)).toBe(rules.length);

    const names = ["a.ts", "a.tsx", "a.json", "package.json", "Cargo.toml", "README.md", "x.unknownext", ".gitignore"];
    const answer = fileIconsAnswer(names, null, real);
    expect(answer.rules.map(([cls]) => cls)).toEqual([...new Set(answer.icons.map(([, cls]) => cls))]);
    for (const [, css] of answer.rules) expect(css).toContain("url(\"data:image/svg+xml,");
    const json = answer.rules.find(([cls]) => cls === "vsi-file-type-json")![1];
    expect(json).toContain(':root[data-ppm-theme="light"] .vsi-file-type-json {');
  });
});
