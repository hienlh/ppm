import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const release = readFileSync(resolve(import.meta.dir, "../../../scripts/release.sh"), "utf8");

describe("release frontend staging", () => {
  it("stages Monaco and its compressed variants before publishing", () => {
    // npm publish uses --ignore-scripts in this release path, so prepublishOnly
    // cannot be the only place that copies Monaco into the shipped web bundle.
    const build = release.indexOf("bun run build:web");
    const monaco = release.indexOf("bun scripts/copy-monaco.ts");
    const precompress = release.indexOf("bun scripts/precompress-web.ts");

    expect(build).toBeGreaterThanOrEqual(0);
    expect(monaco).toBeGreaterThan(build);
    expect(precompress).toBeGreaterThan(monaco);
    expect(release).toContain("npm publish --access public --ignore-scripts");
  });
});
