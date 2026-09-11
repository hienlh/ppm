/**
 * A `diff` language for Monaco, which does not ship one.
 *
 * Monaco's 91 basic languages have no `diff` — VS Code's comes from a bundled
 * extension that standalone Monaco does not include. The consequence is quiet
 * in exactly the way an unmapped semantic token is: a ```diff fenced block in a
 * hover still renders, still runs through the tokenizer, and every line comes
 * back as `mtk1` — the theme's default foreground. So the blame hover's diff
 * looked like plain text where VS Code shows red and green.
 *
 * Registered from the editor rather than at module load, because it is only
 * needed once a Monaco instance exists, and `registerDiffLanguage` is called
 * from every editor mount.
 *
 * The colours live in `src/web/theme/diff-token-rules.ts`: a tokenizer without
 * matching theme rules would be the same silent no-op again.
 */
import type * as MonacoType from "monaco-editor";

export const DIFF_LANGUAGE_ID = "diff";

let registered = false;

export function registerDiffLanguage(monaco: typeof MonacoType): void {
  if (registered) return;
  // Monaco may already know it if a future version adds one; registering twice
  // would stack tokenizers.
  if (monaco.languages.getLanguages().some((l) => l.id === DIFF_LANGUAGE_ID)) {
    registered = true;
    return;
  }

  monaco.languages.register({ id: DIFF_LANGUAGE_ID, aliases: ["Diff", "patch"], extensions: [".diff", ".patch"] });
  monaco.languages.setMonarchTokensProvider(DIFF_LANGUAGE_ID, {
    // Line-oriented, so every rule is anchored and consumes the whole line.
    // Order matters: `+++`/`---` are file headers and must be matched before
    // the single-character `+`/`-` insert and delete rules, or a header would
    // colour as an added line.
    tokenizer: {
      root: [
        [/^diff .*$/, "meta.diff.header"],
        [/^(index|similarity index|rename from|rename to|new file mode|deleted file mode|old mode|new mode) .*$/, "meta.diff.header"],
        [/^(\+\+\+|---) .*$/, "meta.diff.header"],
        [/^@@.*$/, "meta.diff.range"],
        [/^\+.*$/, "inserted"],
        [/^-.*$/, "deleted"],
        // `\ No newline at end of file` is metadata about the patch, not a
        // comment and not content — the same class as the file headers. Calling
        // it `comment` would have leant on a rule inherited from the base theme
        // instead of one this feature actually declares.
        [/^\\ .*$/, "meta.diff.header"],
        [/^.*$/, ""],
      ],
    },
  });
  registered = true;
}

/** Test seam. */
export function _resetDiffLanguage(): void {
  registered = false;
}
