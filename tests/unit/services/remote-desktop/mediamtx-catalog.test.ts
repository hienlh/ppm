import { describe, expect, test } from "bun:test";
import {
  MEDIAMTX_VERSION, mediamtxAsset, mediamtxSupportedHosts,
} from "../../../../src/services/remote-desktop/mediamtx-catalog.ts";

describe("the pinned MediaMTX catalog", () => {
  test("every asset is pinned by version in its URL and by a real SHA-256", () => {
    for (const host of mediamtxSupportedHosts()) {
      const [platform, arch] = host.split("-") as [NodeJS.Platform, string];
      const asset = mediamtxAsset(platform, arch)!;
      expect(asset.url).toContain(`v${MEDIAMTX_VERSION}`);
      expect(asset.url.endsWith(asset.file)).toBe(true);
      // Lowercase hex, full length: this gate is what stops an executable of unknown
      // provenance being unpacked onto the user's machine.
      expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("the archive kind matches the platform, so the extractor picks the right tool", () => {
    for (const host of mediamtxSupportedHosts()) {
      const [platform, arch] = host.split("-") as [NodeJS.Platform, string];
      const asset = mediamtxAsset(platform, arch)!;
      expect(asset.ext).toBe(platform === "win32" ? "zip" : "tar.gz");
      expect(asset.file.endsWith(asset.ext)).toBe(true);
    }
  });

  // A host with no published build must read as "not available", never fall through to a
  // binary for another architecture — that would install cleanly and fail only at spawn.
  test("a host the release does not publish for answers null rather than something close", () => {
    expect(mediamtxAsset("win32", "arm64")).toBeNull();
    expect(mediamtxAsset("linux", "ia32")).toBeNull();
    expect(mediamtxAsset("freebsd" as NodeJS.Platform, "x64")).toBeNull();
  });

  test("the five hosts PPM ships for are all present", () => {
    expect(mediamtxSupportedHosts().sort()).toEqual(
      ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"],
    );
  });
});
