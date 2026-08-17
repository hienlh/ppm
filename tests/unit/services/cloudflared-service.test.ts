import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { getDownloadUrl, getQuickTunnelArgs } from "../../../src/services/cloudflared.service.ts";

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

  describe("getQuickTunnelArgs", () => {
    let ppmHome: string;
    let prevHome: string | undefined;

    beforeAll(() => {
      prevHome = process.env.PPM_HOME;
      ppmHome = mkdtempSync(resolve(tmpdir(), "ppm-cf-"));
      process.env.PPM_HOME = ppmHome;
    });

    afterAll(() => {
      if (prevHome === undefined) delete process.env.PPM_HOME;
      else process.env.PPM_HOME = prevHome;
      rmSync(ppmHome, { recursive: true, force: true });
    });

    test("pins --config before the tunnel subcommand so ~/.cloudflared/config.yml is ignored", () => {
      const args = getQuickTunnelArgs(8080);
      expect(args[0]).toBe("--config");
      expect(args.indexOf("--config")).toBeLessThan(args.indexOf("tunnel"));
      expect(args.slice(2)).toEqual(["tunnel", "--url", "http://127.0.0.1:8080"]);
    });

    test("creates an empty config file with no ingress rules", () => {
      const configPath = getQuickTunnelArgs(8080)[1]!;
      expect(existsSync(configPath)).toBe(true);
      const body = readFileSync(configPath, "utf-8");
      expect(body.replace(/#.*/g, "").trim()).toBe("");
    });
  });
});
