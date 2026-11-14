/**
 * The title a new manager chat gets when nobody names it: "QL <project>", within the session
 * tools' title limit, so a long project name never makes the create refuse it.
 */
import { describe, expect, test } from "bun:test";
import { defaultManagerTitle } from "../../../src/shared/assistant-managers.ts";
import { MAX_COLLAB_TITLE_CHARS } from "../../../src/services/session-collab/session-collab-tool.ts";

describe("defaultManagerTitle", () => {
  test("names the project", () => {
    expect(defaultManagerTitle("ppm")).toBe("QL ppm");
    expect(defaultManagerTitle("  Nxsys ")).toBe("QL Nxsys");
  });

  test("stays within the session tools' title limit, cut by character", () => {
    const title = defaultManagerTitle("a-very-long-project-name-".repeat(5));
    expect(title.length).toBe(MAX_COLLAB_TITLE_CHARS);
    expect(title.startsWith("QL a-very-long")).toBe(true);
    // An emoji straddling the limit is dropped whole, never split into half a surrogate pair.
    const emoji = defaultManagerTitle(`${"x".repeat(MAX_COLLAB_TITLE_CHARS - 4)}😀😀`);
    expect(Array.from(emoji)).toHaveLength(MAX_COLLAB_TITLE_CHARS);
    expect(emoji.endsWith("😀")).toBe(true);
    expect(/[\uD800-\uDBFF]$/.test(emoji)).toBe(false);
  });
});
