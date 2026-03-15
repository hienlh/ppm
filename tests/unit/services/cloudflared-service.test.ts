import { describe, test, expect } from "bun:test";
import { getDownloadUrl } from "../../../src/services/cloudflared.service.ts";

describe("cloudflared.service", () => {
  describe("getDownloadUrl", () => {
    test("builds correct URL for current platform", () => {
      const url = getDownloadUrl();
      expect(url).toStartWith("https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-");
      // macOS uses .tgz, Linux uses raw binary
      expect(url).toMatch(/cloudflared-(darwin|linux)-(amd64|arm64)(\.tgz)?$/);
    });

    test("URL contains correct OS mapping", () => {
      const url = getDownloadUrl();
      if (process.platform === "darwin") {
        expect(url).toContain("darwin");
        expect(url).toEndWith(".tgz");
      } else if (process.platform === "linux") {
        expect(url).toContain("linux");
        expect(url).not.toEndWith(".tgz");
      }
    });

    test("URL contains correct arch mapping", () => {
      const url = getDownloadUrl();
      if (process.arch === "arm64") {
        expect(url).toContain("arm64");
      } else if (process.arch === "x64") {
        expect(url).toContain("amd64");
      }
    });
  });
});
