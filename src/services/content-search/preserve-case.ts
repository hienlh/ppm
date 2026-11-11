/**
 * VS Code's Preserve Case (`buildReplaceStringWithCasePreserved` in
 * `src/vs/base/common/search.ts`): give `replacement` the case shape of the
 * text it replaces — all upper, all lower, capitalised — and, when both are
 * split by `-` or `_` into the same number of parts, part by part.
 * `replacement` is the already-expanded replace text (after `$1`…).
 */
export function preserveCase(matched: string, replacement: string): string {
  if (matched === "") return replacement;

  const hyphens = splitsAlike(matched, replacement, "-");
  const underscores = splitsAlike(matched, replacement, "_");
  if (hyphens && !underscores) return byParts(matched, replacement, "-");
  if (!hyphens && underscores) return byParts(matched, replacement, "_");

  if (matched.toUpperCase() === matched) return replacement.toUpperCase();
  if (matched.toLowerCase() === matched) return replacement.toLowerCase();
  const first = matched.charAt(0);
  if (replacement.length === 0) return replacement;
  if (first.toLowerCase() !== first) return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  if (first.toUpperCase() !== first) return replacement.charAt(0).toLowerCase() + replacement.slice(1);
  return replacement;
}

function splitsAlike(matched: string, replacement: string, sep: string): boolean {
  return (
    matched.includes(sep) &&
    replacement.includes(sep) &&
    matched.split(sep).length === replacement.split(sep).length
  );
}

function byParts(matched: string, replacement: string, sep: string): string {
  const matchedParts = matched.split(sep);
  return replacement
    .split(sep)
    .map((part, i) => preserveCase(matchedParts[i] ?? "", part))
    .join(sep);
}
