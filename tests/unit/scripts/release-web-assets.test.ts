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

  it("builds the design share reviewer page inside build:web, after the app build", () => {
    // release.sh and prepublishOnly both run only build:web, so a separate script would ship
    // releases whose /s/<code> answers 503 "not built". It must also come after the app
    // build, which empties dist/web.
    const pkg = JSON.parse(readFileSync(resolve(import.meta.dir, "../../../package.json"), "utf8"));
    const buildWeb: string = pkg.scripts["build:web"];
    const app = buildWeb.indexOf("--config vite.config.ts");
    const share = buildWeb.indexOf("--config vite.share.config.ts");
    expect(app).toBeGreaterThanOrEqual(0);
    expect(share).toBeGreaterThan(app);
    expect(pkg.scripts.build.startsWith("bun run build:web &&")).toBe(true);
  });
});
