/**
 * Every token type a server can send needs a colour.
 *
 * Standalone Monaco resolves a semantic token against the theme's rule trie and
 * falls back to the default foreground when nothing matches. So a missing rule
 * is not "no semantic colour for that kind" — it is *plain text*, replacing
 * whatever the regex tokenizer had painted. That failure is invisible in code
 * review and only shows up as a file that went monochrome, which is why the
 * coverage is asserted here rather than eyeballed.
 */
import { describe, it, expect } from "bun:test";
import { semanticTokenRules } from "../../../src/web/theme/semantic-token-rules.ts";

/** The standard list from the LSP 3.17 specification. */
const SPEC_TOKEN_TYPES = [
  "namespace", "type", "class", "enum", "interface", "struct", "typeParameter",
  "parameter", "variable", "property", "enumMember", "event", "function",
  "method", "macro", "keyword", "modifier", "comment", "string", "number",
  "regexp", "operator", "decorator",
];

/**
 * Captured from `typescript-language-server` 6.x against PPM's own source.
 * Note `member`, which is not in the specification.
 */
const TSSERVER_LEGEND = [
  "class", "enum", "interface", "namespace", "typeParameter", "type",
  "parameter", "variable", "enumMember", "property", "function", "member",
];

/** Names the inherited `vs`/`vs-dark` base already colours identically. */
const INHERITED = ["keyword", "string", "comment", "number", "regexp", "operator"];

const namesFor = (mode: "dark" | "light") => semanticTokenRules(mode).map((r) => r.token);

describe("semanticTokenRules", () => {
  it("colours every token type typescript-language-server actually sends", () => {
    const names = namesFor("dark");

    expect(TSSERVER_LEGEND.filter((type) => !names.includes(type))).toEqual([]);
  });

  it("colours every specification token type it does not deliberately inherit", () => {
    const names = namesFor("dark");
    const missing = SPEC_TOKEN_TYPES.filter((type) => !names.includes(type) && !INHERITED.includes(type));

    expect(missing).toEqual([]);
  });

  it("leaves the names the base theme already colours alone", () => {
    // Overriding these would change the regex tokenizer's colours too, in every
    // language, so a highlighted comment would not match an unhighlighted one.
    const names = namesFor("dark");

    expect(INHERITED.filter((type) => names.includes(type))).toEqual([]);
  });

  it("gives readonly its own colour, matched by prefix for the rest", () => {
    // A server sends `variable.declaration.readonly.local`; Monaco walks the
    // dots, so a rule on `variable.readonly` is what catches it.
    const names = namesFor("dark");

    expect(names).toContain("variable.readonly");
    expect(names).toContain("property.readonly");
  });

  it("declares each rule once, so none is silently overwritten", () => {
    const names = namesFor("dark");

    expect(new Set(names).size).toBe(names.length);
  });

  it("gives every rule a foreground", () => {
    const withoutColour = semanticTokenRules("dark").filter((rule) => !rule.foreground);

    expect(withoutColour).toEqual([]);
  });

  it("uses bare six-digit hex, which is what defineTheme accepts", () => {
    // Monaco rejects `#rrggbb` and `rgba()` in a token rule's foreground.
    for (const rule of [...semanticTokenRules("dark"), ...semanticTokenRules("light")]) {
      expect(rule.foreground).toMatch(/^[0-9A-Fa-f]{6}$/);
    }
  });

  it("has a distinct palette per mode", () => {
    const dark = semanticTokenRules("dark");
    const light = semanticTokenRules("light");

    expect(dark.map((r) => r.token)).toEqual(light.map((r) => r.token));
    expect(dark.map((r) => r.foreground)).not.toEqual(light.map((r) => r.foreground));
  });

  it("keeps types, functions and variables visually apart", () => {
    // The point of the feature is telling a class from a function from a local;
    // one palette entry reused for two of them would defeat it.
    for (const mode of ["dark", "light"] as const) {
      const by = new Map(semanticTokenRules(mode).map((r) => [r.token, r.foreground]));
      const distinct = new Set([by.get("class"), by.get("function"), by.get("variable"), by.get("enumMember")]);

      expect(distinct.size).toBe(4);
    }
  });
});
