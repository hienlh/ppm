import { describe, it, expect } from "bun:test";
import {
  getBinaryArtifact,
  buildAssetUrl,
  buildSha256SumsUrl,
} from "../../../src/services/binary-upgrade-artifact.ts";

describe("getBinaryArtifact — supported matrix", () => {
  it("darwin arm64 → tar.gz", () => {
    expect(getBinaryArtifact("darwin", "arm64")).toEqual({ artifact: "ppm-darwin-arm64", ext: "tar.gz" });
  });
  it("darwin x64 → tar.gz", () => {
    expect(getBinaryArtifact("darwin", "x64")).toEqual({ artifact: "ppm-darwin-x64", ext: "tar.gz" });
  });
  it("linux x64 → tar.gz", () => {
    expect(getBinaryArtifact("linux", "x64")).toEqual({ artifact: "ppm-linux-x64", ext: "tar.gz" });
  });
  it("linux arm64 → tar.gz", () => {
    expect(getBinaryArtifact("linux", "arm64")).toEqual({ artifact: "ppm-linux-arm64", ext: "tar.gz" });
  });
  it("win32 x64 → windows token + zip", () => {
    expect(getBinaryArtifact("win32", "x64")).toEqual({ artifact: "ppm-windows-x64", ext: "zip" });
  });
});

describe("getBinaryArtifact — unsupported combos throw", () => {
  it("unsupported arch on linux", () => {
    expect(() => getBinaryArtifact("linux", "ia32")).toThrow(/Unsupported arch/);
  });
  it("unsupported platform", () => {
    expect(() => getBinaryArtifact("freebsd" as NodeJS.Platform, "x64")).toThrow(/Unsupported platform/);
  });
  it("windows arm64 not published", () => {
    expect(() => getBinaryArtifact("win32", "arm64")).toThrow(/Unsupported arch/);
  });
});

describe("URL builders", () => {
  it("buildAssetUrl", () => {
    expect(buildAssetUrl("1.2.3", "ppm-linux-x64", "tar.gz")).toBe(
      "https://github.com/hienlh/ppm/releases/download/v1.2.3/ppm-linux-x64.tar.gz",
    );
  });
  it("buildSha256SumsUrl", () => {
    expect(buildSha256SumsUrl("1.2.3")).toBe(
      "https://github.com/hienlh/ppm/releases/download/v1.2.3/SHA256SUMS",
    );
  });
});
