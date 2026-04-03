import { describe, it, expect } from "bun:test";
import { Uri } from "../../../packages/vscode-compat/src/uri.ts";

describe("Uri", () => {
  describe("Uri.file", () => {
    it("creates file URI with correct scheme and path", () => {
      const uri = Uri.file("/home/user/file.txt");
      expect(uri.scheme).toBe("file");
      expect(uri.path).toBe("/home/user/file.txt");
      expect(uri.authority).toBe("");
    });

    it("fsPath returns the path", () => {
      const uri = Uri.file("/tmp/test");
      expect(uri.fsPath).toBe("/tmp/test");
    });

    it("toString produces file:// URL", () => {
      const uri = Uri.file("/home/user/file.txt");
      expect(uri.toString()).toBe("file:///home/user/file.txt");
    });
  });

  describe("Uri.parse", () => {
    it("parses HTTP URL", () => {
      const uri = Uri.parse("https://example.com/path?q=1#frag");
      expect(uri.scheme).toBe("https");
      expect(uri.authority).toBe("example.com");
      expect(uri.path).toBe("/path");
      expect(uri.query).toBe("q=1");
      expect(uri.fragment).toBe("frag");
    });

    it("falls back to file URI for non-URL strings", () => {
      const uri = Uri.parse("/some/local/path");
      expect(uri.scheme).toBe("file");
      expect(uri.path).toBe("/some/local/path");
    });

    it("decodes percent-encoded paths", () => {
      const uri = Uri.parse("https://example.com/my%20file.txt");
      expect(uri.path).toBe("/my file.txt");
    });
  });

  describe("with", () => {
    it("creates modified URI without mutating original", () => {
      const original = Uri.file("/original");
      const modified = original.with({ path: "/modified" });

      expect(original.path).toBe("/original");
      expect(modified.path).toBe("/modified");
      expect(modified.scheme).toBe("file");
    });

    it("changes scheme", () => {
      const uri = Uri.file("/test").with({ scheme: "https" });
      expect(uri.scheme).toBe("https");
    });
  });

  describe("toJSON", () => {
    it("serializes all components", () => {
      const uri = Uri.parse("https://host/path?q=1#f");
      const json = uri.toJSON();
      expect(json.scheme).toBe("https");
      expect(json.authority).toBe("host");
      expect(json.path).toBe("/path");
      expect(json.query).toBe("q=1");
      expect(json.fragment).toBe("f");
    });
  });
});
