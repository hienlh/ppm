/** A fence longer than any backtick run in `code`, so code containing Markdown fences stays one quoted block. */
export function codeFence(code: string): string {
  // A loop, not `Math.max(...runs)`: a large selection has more runs than a call takes arguments.
  let longestFence = 2;
  for (const run of code.match(/`+/g) ?? []) longestFence = Math.max(longestFence, run.length);
  return "`".repeat(longestFence + 1);
}
