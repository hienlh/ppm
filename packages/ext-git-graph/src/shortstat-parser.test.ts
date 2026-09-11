import { describe, it, expect } from "bun:test";
import { parseShortstat } from "./shortstat-parser.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

describe("parseShortstat", () => {
  it("reads insertions and deletions", () => {
    const out = parseShortstat(`${A}\n 3 files changed, 12 insertions(+), 4 deletions(-)\n`);
    expect(out[A]).toEqual({ files: 3, insertions: 12, deletions: 4 });
  });

  it("handles a commit that only adds, and one that only deletes", () => {
    const out = parseShortstat(
      `${A}\n 1 file changed, 2 insertions(+)\n\n${B}\n 1 file changed, 7 deletions(-)\n`,
    );
    expect(out[A]).toEqual({ files: 1, insertions: 2, deletions: 0 });
    expect(out[B]).toEqual({ files: 1, insertions: 0, deletions: 7 });
  });

  it("leaves a merge commit out rather than giving it zeroes", () => {
    // git prints no diffstat for a merge by default. Absent and 0/0 are
    // different things: one is "not computed", the other is "changed nothing".
    const out = parseShortstat(`${A}\n\n${B}\n 2 files changed, 1 insertion(+)\n`);
    expect(out[A]).toBeUndefined();
    expect(out[B]).toEqual({ files: 2, insertions: 1, deletions: 0 });
  });

  it("keeps each stat with the hash printed before it", () => {
    const out = parseShortstat(
      `${A}\n 1 file changed, 1 insertion(+)\n\n${B}\n 2 files changed, 2 insertions(+)\n\n${C}\n 3 files changed, 3 deletions(-)\n`,
    );
    expect(out[A]!.insertions).toBe(1);
    expect(out[B]!.insertions).toBe(2);
    expect(out[C]!.deletions).toBe(3);
  });

  it("ignores a stat line with no hash before it", () => {
    const out = parseShortstat(" 9 files changed, 9 insertions(+)\n");
    expect(Object.keys(out)).toEqual([]);
  });

  it("ignores anything that is not a full hash", () => {
    // A short hash in a commit message must not be mistaken for a record start.
    const out = parseShortstat(`8abb115\n 1 file changed, 1 insertion(+)\n`);
    expect(Object.keys(out)).toEqual([]);
  });

  it("is empty for empty output", () => {
    expect(parseShortstat("")).toEqual({});
  });
});
