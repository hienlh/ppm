/**
 * The bridge's path confinement.
 *
 * A document path arrives from the browser and ends up as a URI handed to a
 * language server, which will read whatever it is pointed at and report the
 * contents back as hovers and diagnostics. This is the only thing standing
 * between that and any file the PPM process can read.
 */
import { describe, it, expect } from "bun:test";
import { resolveDocumentPath } from "../../../src/server/ws/lsp.ts";

const PROJECT = "/home/ada/repo";

describe("resolveDocumentPath", () => {
  it("resolves a path inside the project", () => {
    expect(resolveDocumentPath(PROJECT, "src/app.ts")).toBe("/home/ada/repo/src/app.ts");
  });

  it("allows the project root itself", () => {
    expect(resolveDocumentPath(PROJECT, ".")).toBe(PROJECT);
  });

  it("normalises a path that stays inside", () => {
    expect(resolveDocumentPath(PROJECT, "src/../src/app.ts")).toBe("/home/ada/repo/src/app.ts");
  });

  it("refuses a traversal out of the project", () => {
    for (const attempt of [
      "../outside.ts",
      "../../etc/passwd",
      "src/../../outside.ts",
      "src/../../../.ssh/id_rsa",
    ]) {
      expect(() => resolveDocumentPath(PROJECT, attempt)).toThrow(/escapes the project/);
    }
  });

  it("refuses an absolute path outside the project", () => {
    // `resolve` treats an absolute second argument as the whole answer, so this
    // would otherwise walk straight out.
    expect(() => resolveDocumentPath(PROJECT, "/etc/passwd")).toThrow(/escapes the project/);
  });

  it("accepts an absolute path that is inside the project", () => {
    expect(resolveDocumentPath(PROJECT, "/home/ada/repo/src/app.ts")).toBe("/home/ada/repo/src/app.ts");
  });

  it("refuses a sibling directory sharing the project's prefix", () => {
    // A plain `startsWith` without the separator would accept this.
    expect(() => resolveDocumentPath(PROJECT, "/home/ada/repo-secrets/keys.ts"))
      .toThrow(/escapes the project/);
  });

  it("refuses an empty path and one carrying control characters", () => {
    expect(() => resolveDocumentPath(PROJECT, "")).toThrow(/Invalid document path/);
    expect(() => resolveDocumentPath(PROJECT, "src/app\u0000.ts")).toThrow(/Invalid document path/);
    expect(() => resolveDocumentPath(PROJECT, "src/a\nb.ts")).toThrow(/Invalid document path/);
  });

  it("keeps a path with spaces and non-ASCII", () => {
    expect(resolveDocumentPath(PROJECT, "tài liệu/my file.ts"))
      .toBe("/home/ada/repo/tài liệu/my file.ts");
  });
});
