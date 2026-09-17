/**
 * Colours for the token types a language server reports.
 *
 * Standalone Monaco resolves a semantic token through the very same theme rules
 * as a TextMate scope: `StandaloneTheme.getTokenStyleMetadata` joins the token
 * type and its modifiers with dots and matches that against the rule trie. So
 * `class` needs a rule named `class`, and `variable.readonly.declaration` falls
 * back through `variable.readonly` to `variable`.
 *
 * A token type with no rule resolves to the theme's default foreground, which
 * is why this table has to exist before the capability is advertised: turning
 * semantic highlighting on without it would take every class and function name
 * the regex tokenizer had coloured and flatten it to plain text.
 *
 * The palette is VS Code's Dark+ and Light+, because PPM's themes set no editor
 * rules of their own and inherit their syntax colours from Monaco's `vs-dark`
 * and `vs` — which are that same family. A theme's own `editor.rules` are
 * applied after these, so a theme can still override any of it.
 */
import type { MonacoTokenRule } from "./types";

interface SyntaxPalette {
  /** Types, classes, interfaces, enums — the things a name can be. */
  type: string;
  /** Functions, methods, macros. */
  function: string;
  /** Variables, parameters, properties. */
  variable: string;
  /** Things that cannot change: enum members and anything `readonly`. */
  constant: string;
  /** Keywords and modifiers (`public`, `async`). */
  keyword: string;
}

const DARK_PLUS: SyntaxPalette = {
  type: "4EC9B0",
  function: "DCDCAA",
  variable: "9CDCFE",
  constant: "4FC1FF",
  keyword: "569CD6",
};

const LIGHT_PLUS: SyntaxPalette = {
  type: "267F99",
  function: "795E26",
  variable: "001080",
  constant: "0070C1",
  keyword: "0000FF",
};

/**
 * Rules for every standard LSP semantic token type.
 *
 * `keyword`, `string`, `comment`, `number`, `regexp` and `operator` are absent
 * on purpose: the inherited base theme already colours those names, and its
 * values are the ones the regex tokenizer has been using, so leaving them alone
 * keeps a semantically highlighted comment the same colour as an unhighlighted
 * one.
 *
 * Deprecation is the one thing VS Code shows that this does not — it strikes
 * through a `deprecated` token, which here would mean repeating every rule with
 * a `.deprecated` suffix. A deprecated symbol still carries a diagnostic.
 */
export function semanticTokenRules(mode: "dark" | "light"): MonacoTokenRule[] {
  const p = mode === "dark" ? DARK_PLUS : LIGHT_PLUS;

  return [
    // Named types. `type` is included even though the base theme has a rule for
    // it, so that a type and a class beside it are not two different teals.
    { token: "namespace", foreground: p.type },
    { token: "type", foreground: p.type },
    { token: "class", foreground: p.type },
    { token: "enum", foreground: p.type },
    { token: "interface", foreground: p.type },
    { token: "struct", foreground: p.type },
    { token: "typeParameter", foreground: p.type },

    { token: "function", foreground: p.function },
    { token: "method", foreground: p.function },
    // `member` is not in the specification's list. `typescript-language-server`
    // sends it for methods, and it is the third most common token in a TS file,
    // so leaving it out flattened every method call to plain text. A server is
    // free to extend the legend like this, which is why the rules cover more
    // than the standard names.
    { token: "member", foreground: p.function },
    { token: "macro", foreground: p.function },
    { token: "decorator", foreground: p.function },

    // Overridden rather than inherited: `vs-dark` paints `variable` bright cyan
    // for the shell and CSS tokenizers, and every identifier in a file turning
    // that colour is not what VS Code looks like.
    { token: "variable", foreground: p.variable },
    { token: "parameter", foreground: p.variable },
    { token: "property", foreground: p.variable },
    { token: "event", foreground: p.variable },

    { token: "enumMember", foreground: p.constant },
    { token: "variable.readonly", foreground: p.constant },
    { token: "property.readonly", foreground: p.constant },

    { token: "modifier", foreground: p.keyword },
  ];
}
