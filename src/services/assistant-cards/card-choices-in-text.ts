/**
 * Whether a card's text lists choices for the user ("(1) … (2) …", "A) … B) …") instead of
 * offering them as `options`. Used only to warn: PPM never builds buttons from such text, because
 * a guess at where one choice ends and the next begins could put an approval behind a button the
 * manager never meant to offer.
 *
 * Two markers in order are needed (the first and the second), neither glued to a word, so "step (1)"
 * alone or a function call `f(a)` is not a list.
 */
const LISTS: readonly RegExp[] = [
  // (1) … (2)   or   (a) … (b)
  /(?<![\p{L}\p{N}_])\(\s*1\s*\)[\s\S]*?(?<![\p{L}\p{N}_])\(\s*2\s*\)/mu,
  /(?<![\p{L}\p{N}_])\(\s*a\s*\)[\s\S]*?(?<![\p{L}\p{N}_])\(\s*b\s*\)/imu,
  // 1) … 2)   or   A) … B)
  /(?<![\p{L}\p{N}_(])1\)(?=\s)[\s\S]*?(?<![\p{L}\p{N}_(])2\)(?=\s|$)/mu,
  /(?<![\p{L}\p{N}_(])a\)(?=\s)[\s\S]*?(?<![\p{L}\p{N}_(])b\)(?=\s|$)/imu,
  // "Option A … Option B" / "Option 1 … Option 2"
  /\boption\s+(?:a|1)\b[\s\S]*?\boption\s+(?:b|2)\b/iu,
];

export function listsChoicesInText(text: string): boolean {
  return LISTS.some((re) => re.test(text));
}
