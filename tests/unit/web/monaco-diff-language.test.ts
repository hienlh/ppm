/**
 * The `diff` language Monaco does not ship, and the colours it needs.
 *
 * This pairing is the whole point of the tests. A tokenizer whose token names
 * have no theme rule is not a no-op that shows up in review — it runs, produces
 * tokens, and every one of them resolves to the theme's default foreground. The
 * blame hover's diff looked exactly like plain text that way, which is the same
 * failure semantic highlighting shipped with once already.
 *
 * So the assertion is not "the rules look right", it is "every token this
 * tokenizer can emit has a colour", read out of the tokenizer itself. A rule
 * added to the Monarch table without a matching colour fails here.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import type * as MonacoType from "monaco-editor";
import {
  DIFF_LANGUAGE_ID,
  _resetDiffLanguage,
  registerDiffLanguage,
} from "../../../src/web/lib/monaco-diff-language.ts";
import { diffTokenRules } from "../../../src/web/theme/diff-token-rules.ts";

/** Records what was registered. */
function fakeMonaco(existing: string[] = []) {
  const calls: {
    languages: MonacoType.languages.ILanguageExtensionPoint[];
    tokenizers: Array<{ id: string; definition: MonacoType.languages.IMonarchLanguage }>;
  } = { languages: [], tokenizers: [] };

  const monaco = {
    languages: {
      getLanguages: () => existing.map((id) => ({ id })),
      register: (language: MonacoType.languages.ILanguageExtensionPoint) => calls.languages.push(language),
      setMonarchTokensProvider: (id: string, definition: MonacoType.languages.IMonarchLanguage) =>
        calls.tokenizers.push({ id, definition }),
    },
  } as unknown as typeof MonacoType;

  return { monaco, calls };
}

/** Every token name the registered tokenizer can produce. */
function emittedTokens(definition: MonacoType.languages.IMonarchLanguage): string[] {
  const root = (definition.tokenizer as Record<string, unknown[]>).root;
  return root
    .map((rule) => (rule as [RegExp, string])[1])
    .filter((token): token is string => typeof token === "string" && token.length > 0);
}

beforeEach(() => {
  _resetDiffLanguage();
});

describe("registerDiffLanguage", () => {
  it("registers the language Monaco lacks", () => {
    // Monaco ships 91 basic languages and `diff` is not one of them; VS Code's
    // comes from a bundled extension standalone Monaco does not include.
    const { monaco, calls } = fakeMonaco();

    registerDiffLanguage(monaco);

    expect(calls.languages.map((l) => l.id)).toEqual([DIFF_LANGUAGE_ID]);
    expect(calls.tokenizers.map((t) => t.id)).toEqual([DIFF_LANGUAGE_ID]);
  });

  it("does nothing on a second call", () => {
    // Called from every editor mount.
    const { monaco, calls } = fakeMonaco();

    registerDiffLanguage(monaco);
    registerDiffLanguage(monaco);

    expect(calls.tokenizers).toHaveLength(1);
  });

  it("leaves a diff language Monaco already has alone", () => {
    // A future Monaco adding one would otherwise get a second tokenizer stacked
    // on top of its own.
    const { monaco, calls } = fakeMonaco(["typescript", "diff"]);

    registerDiffLanguage(monaco);

    expect(calls.languages).toEqual([]);
    expect(calls.tokenizers).toEqual([]);
  });
});

describe("diff colours", () => {
  it("colours every token the tokenizer emits", () => {
    // The failure this prevents: a Monarch rule with a token name that has no
    // theme rule renders as the default foreground — a diff that looks like
    // plain text, which is what the hover shipped with the first time.
    const { monaco, calls } = fakeMonaco();
    registerDiffLanguage(monaco);
    const emitted = new Set(emittedTokens(calls.tokenizers[0]!.definition));

    for (const mode of ["dark", "light"] as const) {
      const coloured = new Set(diffTokenRules(mode).map((r) => r.token));
      const uncoloured = [...emitted].filter((token) => !coloured.has(token));

      expect(uncoloured).toEqual([]);
    }
  });

  it("names nothing the tokenizer cannot produce", () => {
    // The other direction: a stale rule is dead weight that reads as coverage.
    const { monaco, calls } = fakeMonaco();
    registerDiffLanguage(monaco);
    const emitted = new Set(emittedTokens(calls.tokenizers[0]!.definition));
    const extra = diffTokenRules("dark")
      .map((r) => r.token)
      .filter((token) => !emitted.has(token));

    expect(extra).toEqual([]);
  });

  it("tells added lines from removed ones in both modes", () => {
    for (const mode of ["dark", "light"] as const) {
      const rules = diffTokenRules(mode);
      const inserted = rules.find((r) => r.token === "inserted")?.foreground;
      const deleted = rules.find((r) => r.token === "deleted")?.foreground;

      expect(inserted).toBeTruthy();
      expect(deleted).toBeTruthy();
      expect(inserted).not.toBe(deleted);
    }
  });

  it("gives every colour as a bare hex triple, which is what Monaco accepts", () => {
    for (const mode of ["dark", "light"] as const) {
      for (const rule of diffTokenRules(mode)) {
        expect(rule.foreground).toMatch(/^[0-9A-Fa-f]{6}$/);
      }
    }
  });
});
