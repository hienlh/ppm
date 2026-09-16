/**
 * The bridge's path confinement.
 *
 * A document path arrives from the browser and ends up as a URI handed to a
 * language server, which will read whatever it is pointed at and report the
 * contents back as hovers and diagnostics. This is the only thing standing
 * between that and any file the PPM process can read.
 *
 * Every case runs against *both* platforms' path semantics rather than the
 * host's, because the two differ in ways that matter here: `..\..` is a
 * traversal only on Windows, `/etc/passwd` lands on `C:\etc\passwd` there, and
 * a drive letter is an escape hatch POSIX has no equivalent for. A suite
 * written against `/home/...` passes on Linux and says nothing at all about the
 * platform half the reviewers are on — and would have been red there, since
 * `resolve` answers with backslashes.
 */
import { describe, it, expect } from "bun:test";
import { posix, win32 } from "node:path";
import { resolveDocumentPath, type PathFlavour } from "../../../src/server/ws/lsp.ts";

const PLATFORMS: { name: string; path: PathFlavour; project: string; outside: string }[] = [
  { name: "posix", path: posix, project: "/home/ada/repo", outside: "/home/ada" },
  { name: "win32", path: win32, project: "C:\\Users\\ada\\repo", outside: "C:\\Users\\ada" },
];

for (const { name, path, project, outside } of PLATFORMS) {
  const inside = (...parts: string[]) => path.join(project, ...parts);

  describe(`resolveDocumentPath on ${name}`, () => {
    const resolveDoc = (relative: string, root = project) => resolveDocumentPath(root, relative, path);

    it("resolves a path inside the project", () => {
      expect(resolveDoc("src/app.ts")).toBe(inside("src", "app.ts"));
    });

    it("allows the project root itself", () => {
      expect(resolveDoc(".")).toBe(project);
    });

    it("normalises a path that stays inside", () => {
      expect(resolveDoc("src/../src/app.ts")).toBe(inside("src", "app.ts"));
    });

    it("refuses a traversal out of the project", () => {
      for (const attempt of [
        "../outside.ts",
        "../../etc/passwd",
        "src/../../outside.ts",
        "src/../../../.ssh/id_rsa",
      ]) {
        expect(() => resolveDoc(attempt)).toThrow(/escapes the project/);
      }
    });

    it("refuses an absolute path outside the project", () => {
      // `resolve` treats an absolute second argument as the whole answer, so this
      // would otherwise walk straight out. On Windows it lands on `C:\etc\passwd`,
      // which is outside for a different reason and equally refused.
      expect(() => resolveDoc("/etc/passwd")).toThrow(/escapes the project/);
    });

    it("accepts an absolute path that is inside the project", () => {
      expect(resolveDoc(inside("src", "app.ts"))).toBe(inside("src", "app.ts"));
    });

    it("refuses a sibling directory sharing the project's prefix", () => {
      // A plain `startsWith` without the separator would accept this.
      expect(() => resolveDoc(`${project}-secrets${path.sep}keys.ts`)).toThrow(/escapes the project/);
    });

    it("refuses an empty path and one carrying control characters", () => {
      expect(() => resolveDoc("")).toThrow(/Invalid document path/);
      expect(() => resolveDoc("src/app\u0000.ts")).toThrow(/Invalid document path/);
      expect(() => resolveDoc("src/a\nb.ts")).toThrow(/Invalid document path/);
    });

    it("keeps a path with spaces and non-ASCII", () => {
      expect(resolveDoc("tài liệu/my file.ts")).toBe(inside("tài liệu", "my file.ts"));
    });

    it("serves a project path spelled with a trailing separator", () => {
      // Config holds whatever was registered. Unnormalised, `project + sep` is a
      // doubled separator that no resolved path starts with, so the guard would
      // refuse every document in the project and the editor would simply have no
      // language server — a breakage that reads as a missing feature.
      expect(resolveDoc("src/app.ts", project + path.sep)).toBe(inside("src", "app.ts"));
      expect(() => resolveDoc("../outside.ts", project + path.sep)).toThrow(/escapes the project/);
    });
  });
}

describe("resolveDocumentPath on Windows specifically", () => {
  const PROJECT = "C:\\Users\\ada\\repo";
  const resolveDoc = (relative: string, root = PROJECT) => resolveDocumentPath(root, relative, win32);

  it("takes a backslash path from a Windows client", () => {
    // The browser sends whatever the server gave it, and on Windows that is
    // backslashes — which POSIX reads as one long filename, so this case only
    // exists here.
    expect(resolveDoc("src\\app.ts")).toBe("C:\\Users\\ada\\repo\\src\\app.ts");
  });

  it("refuses a backslash traversal", () => {
    for (const attempt of ["..\\outside.ts", "src\\..\\..\\outside.ts", "src/..\\..\\outside.ts"]) {
      expect(() => resolveDoc(attempt)).toThrow(/escapes the project/);
    }
  });

  it("refuses another drive, a root-relative path and a UNC share", () => {
    for (const attempt of [
      "C:\\Windows\\System32\\drivers\\etc\\hosts",
      "\\Windows\\win.ini", // root-relative: same drive, top of it
      "\\\\server\\share\\x.ts",
      "D:\\secrets.ts",
    ]) {
      expect(() => resolveDoc(attempt)).toThrow(/escapes the project/);
    }
  });

  it("serves a project path spelled with forward slashes", () => {
    // How a pasted or browser-supplied path arrives. `C:/Users/ada/repo` + `\`
    // is a prefix of nothing `resolve` ever returns, so without normalising the
    // base every document in the project is refused.
    expect(resolveDoc("src/app.ts", "C:/Users/ada/repo")).toBe("C:\\Users\\ada\\repo\\src\\app.ts");
    expect(() => resolveDoc("../outside.ts", "C:/Users/ada/repo")).toThrow(/escapes the project/);
  });
});
