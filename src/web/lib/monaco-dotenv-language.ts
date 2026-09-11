/**
 * A `dotenv` language for Monaco, which does not ship one.
 *
 * Monaco has 82 basic languages and none of them is `.env` — VS Code has none
 * either, it comes from an extension. So an env file opened in PPM was
 * `plaintext`, and plaintext has exactly one colour: a commented-out line and a
 * live one looked identical. In a file whose whole purpose is "which of these
 * settings are on", that is the one distinction the editor has to make.
 *
 * Every token name here is one the base `vs`/`vs-dark` themes already colour
 * (`comment`, `key`, `string`, `variable`, `keyword`, `delimiter`), and the
 * theme adapter defines every PPM theme with `inherit: true` — so this needs no
 * palette of its own and cannot drift from the app's themes. That is why there
 * is no `dotenv-token-rules.ts` beside `diff-token-rules.ts`; the `diff`
 * tokenizer had to invent `inserted`/`deleted`/`meta.diff.*`, which nothing
 * inherited. `tests/unit/web/monaco-dotenv-language.test.ts` pins the pairing
 * against Monaco's own theme table, because a token name with no rule anywhere
 * is the silent no-op that shipped once already.
 *
 * Registered from `beforeMount` rather than `onMount`: the model is created
 * with its language id before `onMount` runs, and a model created against an
 * unregistered id is plaintext.
 */
import type * as MonacoType from "monaco-editor";

export const DOTENV_LANGUAGE_ID = "dotenv";

/**
 * Whether a path is an env file.
 *
 * Covers `.env`, every suffixed variant (`.env.local`, `.env.test.example`) and
 * the `NAME.env` form.
 *
 * direnv's `.envrc` is a shell script and must not match — it does not, because
 * the prefix test requires the separating dot (`.envrc`[4] is `r`). An explicit
 * guard for it was dead code, which mutation testing is what found; the test
 * pins the behaviour instead, so loosening the prefix test fails there.
 *
 * Call this *after* an extension lookup, never before: `.env.example.md`
 * matches the prefix test but is markdown, and the extension map answers first.
 */
export function isDotenvFile(filename: string): boolean {
  const base = filename.split("/").pop() ?? filename;
  return base === ".env" || base.startsWith(".env.") || base.endsWith(".env");
}

let registered = false;

export function registerDotenvLanguage(monaco: typeof MonacoType): void {
  if (registered) return;
  // A future Monaco version adding one would otherwise get a second tokenizer
  // stacked on its own.
  if (monaco.languages.getLanguages().some((l) => l.id === DOTENV_LANGUAGE_ID)) {
    registered = true;
    return;
  }

  monaco.languages.register({
    id: DOTENV_LANGUAGE_ID,
    aliases: ["Dotenv", "env"],
    // Only `.env` itself can be expressed as an extension; the suffixed
    // variants are matched by `isDotenvFile`, because Monaco's own resolution
    // is not what picks the language here — the editor passes it explicitly.
    extensions: [".env"],
  });

  monaco.languages.setLanguageConfiguration(DOTENV_LANGUAGE_ID, {
    // What makes `Ctrl+/` comment a line out — the fastest way to answer the
    // question this language exists for.
    comments: { lineComment: "#" },
    autoClosingPairs: [
      { open: '"', close: '"' },
      { open: "'", close: "'" },
      { open: "${", close: "}" },
    ],
    surroundingPairs: [
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
  });

  monaco.languages.setMonarchTokensProvider(DOTENV_LANGUAGE_ID, {
    // One state, deliberately. The first version used a `@value` state entered
    // on `=` and popped by a `/$/` rule — and Monarch never runs that rule,
    // because its per-line loop stops as soon as the position reaches the end
    // of the line. So the state was never left: from the first assignment on,
    // *every* line in the file was tokenized as a value, including the
    // commented-out ones. `#KEY=off` came back as a string — the exact case
    // this language was written for. A line-oriented grammar has to do
    // everything in `root`, the way Monaco's own `ini` does.
    //
    // The cost is that a quoted value is matched whole rather than piece by
    // piece, so an interpolation inside quotes keeps the string colour. That is
    // the trade for `#` inside a quoted value not reading as a comment, which
    // needs the quotes to be one atomic match.
    tokenizer: {
      root: [
        // The line this language exists for: dimmed, whole, and claimed before
        // any other rule can take part of it. `#` with no space after it is the
        // commonest way to switch a setting off, so it must not need one.
        [/^[ \t]*#.*$/, "comment"],
        // `export KEY=` and plain `KEY=`. Every character the regex matches is
        // inside a group, which is what Monarch requires of a rule that emits
        // more than one token.
        [/^([ \t]*)(export)([ \t]+)([\w.-]+)([ \t]*)(=)/, ["", "keyword", "", "key", "", "delimiter"]],
        [/^([ \t]*)([\w.-]+)([ \t]*)(=)/, ["", "key", "", "delimiter"]],
        // An inline comment needs whitespace in front of it: `KEY=a#b` is the
        // value `a#b` to every dotenv parser, so a bare `#` cannot end a value.
        [/[ \t]+#.*$/, "comment"],
        // Whole-quoted values. Single quotes are literal in dotenv, so an
        // interpolation inside them is text and must not be coloured as one.
        [/"(?:[^"\\]|\\.)*"/, "string"],
        [/'[^']*'/, "string"],
        [/\$\{[^}]*\}/, "variable"],
        [/\$[A-Za-z_]\w*/, "variable"],
        // A bare value, `#` included. An unterminated quote lands here too,
        // which is why one cannot run away with the rest of the file.
        [/[^\s$]+/, "string"],
        [/[ \t]+/, ""],
        [/./, ""],
      ],
    },
  });
  registered = true;
}

/** Test seam. */
export function _resetDotenvLanguage(): void {
  registered = false;
}
