/**
 * Every git argument that reaches the Git Graph extension comes from a webview,
 * so each one goes through a guard in `git-exec.ts` before it reaches `spawn`.
 * The file-path guard is checked against *both* separators here: it is the one
 * that used to reject every path on Windows, and a test that runs only on the
 * host's own platform cannot see that.
 */
import { describe, it, expect } from "bun:test";
import { posix, win32 } from "node:path";
import {
  assertSafeFilePaths,
  assertValidHash,
  assertValidLineNumber,
  assertValidRef,
  assertValidRemote,
} from "../../../packages/ext-git-graph/src/git-exec.ts";

const PLATFORMS = [
  { name: "posix", path: posix, root: "/home/ada/proj", nested: "src/app.ts" },
  { name: "win32", path: win32, root: "C:\\Users\\ada\\proj", nested: "src\\app.ts" },
] as const;

for (const { name, path, root, nested } of PLATFORMS) {
  describe(`assertSafeFilePaths on ${name}`, () => {
    it("accepts an ordinary file in the project", () => {
      expect(() => assertSafeFilePaths(["README.md", nested], root, path)).not.toThrow();
    });

    it("accepts a path written with the other separator", () => {
      // A webview builds paths from git's output, which always uses "/".
      expect(() => assertSafeFilePaths(["src/app.ts"], root, path)).not.toThrow();
    });

    it("accepts the project root itself", () => {
      expect(() => assertSafeFilePaths(["."], root, path)).not.toThrow();
    });

    it("accepts a file whose name starts with two dots", () => {
      // "..gitconfig" is a filename, not a walk upwards.
      expect(() => assertSafeFilePaths(["..gitconfig"], root, path)).not.toThrow();
    });

    it("rejects a walk out of the project", () => {
      expect(() => assertSafeFilePaths([`..${path.sep}secrets.txt`], root, path))
        .toThrow(/escapes project root/);
      expect(() => assertSafeFilePaths(["src/../../secrets.txt"], root, path))
        .toThrow(/escapes project root/);
    });

    it("rejects the parent directory itself", () => {
      expect(() => assertSafeFilePaths([".."], root, path)).toThrow(/escapes project root/);
    });

    it("rejects an absolute path", () => {
      expect(() => assertSafeFilePaths(["/etc/passwd"], root, path)).toThrow(/Invalid file path/);
    });

    it("rejects a leading dash, a control character and an empty path", () => {
      expect(() => assertSafeFilePaths(["--output=/tmp/x"], root, path)).toThrow(/Invalid file path/);
      expect(() => assertSafeFilePaths(["a\u0000b"], root, path)).toThrow(/Invalid file path/);
      expect(() => assertSafeFilePaths([""], root, path)).toThrow(/Invalid file path/);
    });
  });
}

describe("assertSafeFilePaths on win32 specifically", () => {
  it("rejects a path on another drive", () => {
    expect(() => assertSafeFilePaths(["D:\\other\\file.ts"], "C:\\Users\\ada\\proj", win32))
      .toThrow(/Invalid file path/);
  });

  it("rejects a UNC path", () => {
    expect(() => assertSafeFilePaths(["\\\\server\\share\\file.ts"], "C:\\Users\\ada\\proj", win32))
      .toThrow(/Invalid file path/);
  });
});

describe("the other argument guards", () => {
  it("takes a hash or HEAD and nothing else", () => {
    expect(assertValidHash("HEAD")).toBe("HEAD");
    expect(assertValidHash("a1b2c3d")).toBe("a1b2c3d");
    expect(() => assertValidHash("a1b2c3d; rm -rf /")).toThrow(/Invalid commit hash/);
    expect(() => assertValidHash("--upload-pack=x")).toThrow(/Invalid commit hash/);
  });

  it("refuses a ref that git would read as a range or an option", () => {
    expect(assertValidRef("feature/x", "branch")).toBe("feature/x");
    expect(() => assertValidRef("a..b", "branch")).toThrow(/Invalid git ref/);
    expect(() => assertValidRef("--force", "branch")).toThrow(/Invalid git ref/);
    expect(() => assertValidRef("re^f", "branch")).toThrow(/Invalid git ref/);
    expect(() => assertValidRef("", "branch")).toThrow(/Invalid git ref/);
  });

  it("refuses a remote that could be read as an option", () => {
    expect(assertValidRemote("origin")).toBe("origin");
    expect(() => assertValidRemote("--exec=sh")).toThrow(/Invalid remote name/);
  });

  it("refuses a line number that is not a positive integer", () => {
    expect(assertValidLineNumber("12", "start")).toBe(12);
    expect(() => assertValidLineNumber("0", "start")).toThrow(/Invalid line number/);
    expect(() => assertValidLineNumber("1.5", "start")).toThrow(/Invalid line number/);
    expect(() => assertValidLineNumber("1 --output=x", "start")).toThrow(/Invalid line number/);
  });
});
