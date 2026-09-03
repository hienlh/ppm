/**
 * Pulls every file out of a (possibly live) `FileList`-shaped object into a plain array,
 * BEFORE the caller resets the `<input>`'s value. Some Chromium versions empty the input's
 * *live* `FileList` the instant `value` is reset, so calling `resetInput` first silently
 * drops every picked file — this ordering is the one thing that must never be inlined and
 * reshuffled, hence its own pure, unit-testable function.
 */

export interface PickableFileList {
  length: number;
  item(index: number): File | null;
}

export function capturePickedFiles(list: PickableFileList | null, resetInput: () => void): File[] {
  const files = list ? Array.from({ length: list.length }, (_, i) => list.item(i)).filter((f): f is File => f != null) : [];
  resetInput();
  return files;
}
