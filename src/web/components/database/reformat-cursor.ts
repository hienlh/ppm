/** 1-based, as Monaco counts. */
export interface TextPosition {
  lineNumber: number;
  column: number;
}

const BLANK = /\s/;

/**
 * Where the cursor belongs once `before` has been laid out again as `after`, which moves only
 * blanks: by the same character — in front of the one it was in front of when a blank came before
 * it, else just past the one it followed. Both texts end their lines in "\n".
 */
export function cursorAfterReformat(before: string, after: string, at: TextPosition): TextPosition {
  let offset = 0;
  for (let line = 1; line < at.lineNumber; line++) offset = before.indexOf("\n", offset) + 1;
  offset += at.column - 1;

  let passed = 0;
  for (let i = 0; i < offset; i++) if (!BLANK.test(before[i]!)) passed++;
  const inFront = offset === 0 || BLANK.test(before[offset - 1]!);

  // The non-blank to stop at, counted from 0: the next one, or the one just passed.
  const target = inFront ? passed : passed - 1;
  let j = 0;
  for (let n = 0; j < after.length; j++) {
    if (BLANK.test(after[j]!)) continue;
    if (n === target) break;
    n++;
  }
  if (!inFront && j < after.length) j++;

  let lineNumber = 1;
  let lineStart = 0;
  for (let k = after.indexOf("\n"); k !== -1 && k < j; k = after.indexOf("\n", k + 1)) {
    lineNumber++;
    lineStart = k + 1;
  }
  return { lineNumber, column: j - lineStart + 1 };
}
