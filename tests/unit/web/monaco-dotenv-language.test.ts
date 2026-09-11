/**
 * The `dotenv` language Monaco does not ship.
 *
 * An env file was `plaintext`, and plaintext has one colour — so a line that
 * had been commented out looked exactly like a live setting, in the one kind of
 * file where that is the only question being asked.
 *
 * Two things are pinned here that real Monaco had to tell me, because reading
 * the grammar did not:
 *
 * 1. **No tokenizer state.** The first version entered a `@value` state on `=`
 *    and left it with a `/$/` rule. Monarch never runs that rule: its per-line
 *    loop ends the moment the position reaches the end of the line. So the
 *    state was never popped and every line after the first assignment was
 *    tokenized as a value — `#KEY=off` came back `string`, i.e. the exact case
 *    this language exists for was still broken while everything looked right.
 *    A `next:` anywhere in this grammar brings that back, so the test forbids
 *    one outright.
 *
 * 2. **Every token name has a colour.** Not from a file of its own, the way
 *    `diff-token-rules.ts` had to invent `inserted`/`deleted`: these names are
 *    Monaco's own (`comment`, `key`, `string`, `variable`, `keyword`,
 *    `delimiter`) and every PPM theme is defined with `inherit: true`, so the
 *    colours come from the `vs`/`vs-dark` base. That is only true while the
 *    names keep matching, which is what the assertion below reads out of
 *    Monaco's own theme table rather than trusting.
 *
 * Verified against real Monaco loaded from the running server, tokenizing a
 * fixture of the awkward lines (`#KEY=off`, `export K=v`, `K=a#b`,
 * `K="a # b"`, `K='${X}'`, an unterminated quote). Measured colours, dark:
 * comment #608B4E, key #9CDCFE, delimiter #DCDCDC, string #CE9178, keyword
 * #569CD6, variable #74B0DF — six distinct. Light: #008000 / #863B00 /
 * #000000 / #A31515 / #0000FF / #001188.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type * as MonacoType from "monaco-editor";
import {
  DOTENV_LANGUAGE_ID,
  _resetDotenvLanguage,
  isDotenvFile,
  registerDotenvLanguage,
} from "../../../src/web/lib/monaco-dotenv-language.ts";

const root = resolve(import.meta.dir, "../../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

/** Records what was registered. */
function fakeMonaco(existing: string[] = []) {
  const calls: {
    languages: MonacoType.languages.ILanguageExtensionPoint[];
    configs: string[];
    tokenizers: Array<{ id: string; definition: MonacoType.languages.IMonarchLanguage }>;
  } = { languages: [], configs: [], tokenizers: [] };

  const monaco = {
    languages: {
      getLanguages: () => existing.map((id) => ({ id })),
      register: (language: MonacoType.languages.ILanguageExtensionPoint) => calls.languages.push(language),
      setLanguageConfiguration: (id: string) => calls.configs.push(id),
      setMonarchTokensProvider: (id: string, definition: MonacoType.languages.IMonarchLanguage) =>
        calls.tokenizers.push({ id, definition }),
    },
  } as unknown as typeof MonacoType;

  return { monaco, calls };
}

/** The registered grammar. */
function grammar(): MonacoType.languages.IMonarchLanguage {
  const { monaco, calls } = fakeMonaco();
  registerDotenvLanguage(monaco);
  return calls.tokenizers[0]!.definition;
}

/** Every rule in the grammar, flattened across whatever states exist. */
function rules(definition: MonacoType.languages.IMonarchLanguage): unknown[][] {
  return Object.values(definition.tokenizer as Record<string, unknown[][]>).flat() as unknown[][];
}

/** Every token name the grammar can produce. */
function emittedTokens(definition: MonacoType.languages.IMonarchLanguage): string[] {
  return rules(definition)
    .flatMap((rule) => {
      const action = rule[1];
      if (typeof action === "string") return [action];
      if (Array.isArray(action)) return action as string[];
      if (action && typeof action === "object") return [(action as { token?: string }).token ?? ""];
      return [];
    })
    .filter((token): token is string => typeof token === "string" && token.length > 0);
}

/** Token names one of Monaco's own themes gives a colour to. */
function baseThemeTokens(theme: "vs" | "vs-dark"): Set<string> {
  const src = read("node_modules/monaco-editor/esm/vs/editor/standalone/common/themes.js");
  const marks = { vs: ["const vs = {", "const vs_dark = {"], "vs-dark": ["const vs_dark = {", "const hc_black = {"] };
  const [from, to] = marks[theme];
  const start = src.indexOf(from!);
  const end = src.indexOf(to!, start + 1);
  // Fails loudly if a Monaco upgrade renames these — which is when somebody
  // should be looking at whether the colours still exist at all.
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return new Set([...src.slice(start, end).matchAll(/token: '([^']*)'/g)].map((m) => m[1]!));
}

beforeEach(() => {
  _resetDotenvLanguage();
});

describe("registerDotenvLanguage", () => {
  it("registers the language, its comment configuration and its tokenizer", () => {
    const { monaco, calls } = fakeMonaco();

    registerDotenvLanguage(monaco);

    expect(calls.languages.map((l) => l.id)).toEqual([DOTENV_LANGUAGE_ID]);
    expect(calls.configs).toEqual([DOTENV_LANGUAGE_ID]);
    expect(calls.tokenizers.map((t) => t.id)).toEqual([DOTENV_LANGUAGE_ID]);
  });

  it("gives `#` as the line comment, so Ctrl+/ switches a setting off", () => {
    // The fastest possible answer to the question the highlighting exists for.
    const { monaco } = fakeMonaco();
    let config: MonacoType.languages.LanguageConfiguration | undefined;
    (monaco.languages as unknown as { setLanguageConfiguration: unknown }).setLanguageConfiguration = (
      _id: string,
      c: MonacoType.languages.LanguageConfiguration,
    ) => { config = c; };

    registerDotenvLanguage(monaco);

    expect(config?.comments?.lineComment).toBe("#");
  });

  it("does nothing on a second call", () => {
    // Called from every editor mount.
    const { monaco, calls } = fakeMonaco();

    registerDotenvLanguage(monaco);
    registerDotenvLanguage(monaco);

    expect(calls.tokenizers).toHaveLength(1);
  });

  it("leaves a dotenv language Monaco already has alone", () => {
    const { monaco, calls } = fakeMonaco(["typescript", "dotenv"]);

    registerDotenvLanguage(monaco);

    expect(calls.languages).toEqual([]);
    expect(calls.tokenizers).toEqual([]);
  });
});

describe("the grammar is line-oriented, with no state to leak", () => {
  it("has exactly one state", () => {
    // Two states is how the first version broke: see the header.
    expect(Object.keys(grammar().tokenizer as object)).toEqual(["root"]);
  });

  it("never switches state", () => {
    // `next`, `@push`, `@pop` and `@popall` all reintroduce a state that
    // Monarch cannot be relied on to leave at the end of a line.
    const actions = JSON.stringify(rules(grammar()));
    expect(actions).not.toContain("next");
    expect(actions).not.toContain("@pop");
    expect(actions).not.toContain("@push");
  });

  it("treats `#` as a comment with no space after it", () => {
    // `#KEY=value` is how a setting is switched off in practice, and it was
    // what the state leak got wrong.
    const commentRule = rules(grammar()).find((r) => r[1] === "comment");
    expect(commentRule).toBeDefined();
    const re = commentRule![0] as RegExp;
    expect("#KEY=value").toMatch(re);
    expect("  # indented").toMatch(re);
    expect("KEY=value").not.toMatch(re);
    // A comment rule that needed whitespace would still pass every other test
    // here while missing the commonest case.
    expect(re.source).not.toContain("# ");
  });

  it("claims the comment before anything else can take part of the line", () => {
    // A key rule matching first would colour `#KEY` as a key and leave the
    // rest looking live.
    const order = rules(grammar()).map((r) => r[1]);
    expect(order.indexOf("comment")).toBe(0);
  });
});

describe("colours come from Monaco's own base themes", () => {
  for (const theme of ["vs", "vs-dark"] as const) {
    it(`${theme} colours every token the grammar emits`, () => {
      // The failure this prevents: a token name with no rule anywhere renders
      // as the default foreground — a tokenizer that runs and changes nothing,
      // which is how semantic highlighting and the diff language each shipped
      // once. PPM's themes are defined with `inherit: true`, so these are the
      // rules that apply.
      const coloured = baseThemeTokens(theme);
      const uncoloured = [...new Set(emittedTokens(grammar()))].filter((t) => !coloured.has(t));

      expect(uncoloured).toEqual([]);
    });
  }

  it("keeps PPM's themes on inherit, which is what makes that true", () => {
    expect(read("src/web/theme/adapters/monaco-adapter.ts")).toMatch(/inherit: true/);
  });

  it("needs no rules file of its own", () => {
    // Unlike `diff`, which had to invent `inserted`/`deleted`/`meta.diff.*`.
    // If this file ever appears, the reason above changed and the pairing test
    // is looking at the wrong table.
    expect(() => read("src/web/theme/dotenv-token-rules.ts")).toThrow();
  });
});

describe("which files are env files", () => {
  it("matches the plain file, every suffixed variant and the NAME.env form", () => {
    for (const name of [
      ".env", ".env.local", ".env.development", ".env.test", ".env.test.example",
      ".env.production.local", "dev.env", "src/config/.env", "a/b/.env.staging",
    ]) {
      expect(isDotenvFile(name), name).toBe(true);
    }
  });

  it("leaves direnv's file alone", () => {
    // `.envrc` is a shell script; key/value colouring would be wrong on every
    // line of it.
    expect(isDotenvFile(".envrc")).toBe(false);
    expect(isDotenvFile("project/.envrc")).toBe(false);
  });

  it("does not match a name that merely starts with env", () => {
    for (const name of ["environment.ts", "env.js", "envrc", "sender.envelope"]) {
      expect(isDotenvFile(name), name).toBe(false);
    }
  });
});

describe("every editor resolves the language the same way", () => {
  const surfaces = [
    "src/web/components/editor/code-editor.tsx",
    "src/web/components/editor/diff-viewer.tsx",
    "src/web/components/editor/conflict-editor.tsx",
  ];

  for (const file of surfaces) {
    const src = read(file);

    it(`${file.split("/").pop()} falls back to dotenv instead of plaintext`, () => {
      expect(src).toMatch(/return map\[ext\] \?\? \(isDotenvFile\(filename\) \? DOTENV_LANGUAGE_ID : "plaintext"\)/);
    });

    it(`${file.split("/").pop()} asks the extension first`, () => {
      // `.env.example.md` matches the dotenv prefix test but is markdown, so
      // the extension map has to answer before the name test.
      const call = src.indexOf("isDotenvFile(filename)");
      expect(src.slice(0, call)).toContain("map[ext] ??");
    });

    it(`${file.split("/").pop()} registers before mount, not on mount`, () => {
      // A model is created with its language id before `onMount` runs, and one
      // created against an unregistered id stays plaintext.
      expect(src).toMatch(/beforeMount=\{registerDotenvLanguage\}/);
    });
  }

  it("offers it in the language picker", () => {
    // So a file that is an env file under another name can be switched to it.
    expect(read("src/web/components/editor/editor-language-picker.tsx")).toMatch(
      /\{ id: "dotenv", label: "Dotenv" \}/,
    );
  });
});
