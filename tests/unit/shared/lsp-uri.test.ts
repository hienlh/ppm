import { describe, it, expect } from "bun:test";
import { fileUriToPath, pathToFileUri, uriKey } from "../../../src/shared/lsp-uri.ts";

describe("pathToFileUri", () => {
  it("encodes a POSIX path", () => {
    expect(pathToFileUri("/home/ada/src/app.ts")).toBe("file:///home/ada/src/app.ts");
  });

  it("escapes a space without escaping the separators", () => {
    expect(pathToFileUri("/home/ada/my project/app.ts"))
      .toBe("file:///home/ada/my%20project/app.ts");
  });

  it("escapes characters that would otherwise truncate the URI", () => {
    // Unescaped, the "#" would make everything after it a fragment and the
    // server would look for a file that does not exist.
    expect(pathToFileUri("/tmp/a#b?c/d.ts")).toBe("file:///tmp/a%23b%3Fc/d.ts");
  });

  it("keeps non-ASCII readable through percent-encoding", () => {
    expect(pathToFileUri("/home/ada/tài liệu.ts"))
      .toBe("file:///home/ada/t%C3%A0i%20li%E1%BB%87u.ts");
  });

  it("lower-cases a Windows drive and escapes the colon like VS Code", () => {
    expect(pathToFileUri("C:\\Users\\ada\\app.ts")).toBe("file:///c%3A/Users/ada/app.ts");
  });

  it("gives one URI for either casing of a drive letter", () => {
    expect(pathToFileUri("C:\\x\\y.ts")).toBe(pathToFileUri("c:/x/y.ts"));
  });

  it("turns a UNC path into an authority", () => {
    expect(pathToFileUri("\\\\build01\\share\\app.ts")).toBe("file://build01/share/app.ts");
  });
});

describe("fileUriToPath", () => {
  it("round-trips a POSIX path", () => {
    for (const path of ["/home/ada/app.ts", "/home/ada/my project/a#b.ts", "/home/ada/tài liệu.ts"]) {
      expect(fileUriToPath(pathToFileUri(path))).toBe(path);
    }
  });

  it("round-trips a Windows path", () => {
    expect(fileUriToPath(pathToFileUri("C:\\Users\\ada\\app.ts"))).toBe("c:/Users/ada/app.ts");
  });

  it("accepts an unescaped drive colon, which some servers send back", () => {
    expect(fileUriToPath("file:///c:/Users/ada/app.ts")).toBe("c:/Users/ada/app.ts");
  });

  it("accepts the single-slash form", () => {
    expect(fileUriToPath("file:/home/ada/app.ts")).toBe("/home/ada/app.ts");
  });

  it("refuses a scheme that is not a file", () => {
    // A server may report a location inside a virtual document; opening a tab
    // for it as if it were a path would show an empty file.
    for (const uri of ["untitled:Untitled-1", "jdt://contents/rt.jar", "https://example.com/a.ts"]) {
      expect(fileUriToPath(uri)).toBeNull();
    }
  });

  it("survives a stray percent that is not an escape", () => {
    expect(fileUriToPath("file:///tmp/100%/a.ts")).toBe("/tmp/100%/a.ts");
  });
});

describe("uriKey", () => {
  it("collapses the spellings a server might echo back", () => {
    const spellings = [
      "file:///c%3A/Users/ada/app.ts",
      "file:///c%3a/Users/ada/app.ts",
      "file:///c:/Users/ada/app.ts",
      "file:///C:/Users/ada/app.ts",
    ];

    expect(new Set(spellings.map(uriKey)).size).toBe(1);
  });

  it("keeps POSIX paths case-sensitive", () => {
    // Two genuinely different files on Linux — folding them would clear one
    // file's diagnostics when the other's are published.
    expect(uriKey("file:///tmp/App.ts")).not.toBe(uriKey("file:///tmp/app.ts"));
  });

  it("matches an escaped and an unescaped space", () => {
    expect(uriKey("file:///tmp/a%20b/c.ts")).toBe(uriKey(pathToFileUri("/tmp/a b/c.ts")));
  });

  it("passes a non-file URI through unchanged", () => {
    expect(uriKey("untitled:Untitled-1")).toBe("untitled:Untitled-1");
  });
});
