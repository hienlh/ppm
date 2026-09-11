/**
 * Colours for the `diff` tokenizer in `src/web/lib/monaco-diff-language.ts`.
 *
 * VS Code's own values, so a diff in a PPM hover reads the way a diff in VS
 * Code does: green for what a commit added, red for what it removed, and a
 * dimmed blue for the `@@` range and the file headers, which are structure
 * rather than content.
 *
 * These have to exist for the tokenizer to be worth registering at all —
 * a token type with no rule resolves to the theme's default foreground, so
 * the tokenizer would run and change nothing.
 */
import type { MonacoTokenRule } from "./types";

interface DiffPalette {
  inserted: string;
  deleted: string;
  header: string;
}

const DARK: DiffPalette = { inserted: "6A9955", deleted: "CE9178", header: "569CD6" };
const LIGHT: DiffPalette = { inserted: "098658", deleted: "A31515", header: "0000FF" };

export function diffTokenRules(mode: "dark" | "light"): MonacoTokenRule[] {
  const p = mode === "dark" ? DARK : LIGHT;
  return [
    { token: "inserted", foreground: p.inserted },
    { token: "deleted", foreground: p.deleted },
    // Both header kinds share a colour, but stay separate tokens so a theme can
    // tell the `@@` range apart from the `diff --git` line.
    { token: "meta.diff.header", foreground: p.header },
    { token: "meta.diff.range", foreground: p.header },
  ];
}
