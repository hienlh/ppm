/**
 * The title a new manager chat gets when nobody names it: "QL <project>", within the session
 * tools' 60-character title limit, so a long project name never makes the create refuse it.
 */
import { describe, expect, test } from "bun:test";
import { defaultManagerTitle } from "../../../src/shared/assistant-managers.ts";

describe("defaultManagerTitle", () => {
  test("names the project", () => {
    expect(defaultManagerTitle("ppm")).toBe("QL ppm");
    expect(defaultManagerTitle("  Nxsys ")).toBe("QL Nxsys");
  });

  test("stays within 60 characters", () => {
    const title = defaultManagerTitle("a-very-long-project-name-".repeat(5));
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title.startsWith("QL a-very-long")).toBe(true);
  });
});
