import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "../../test-setup.ts";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDesignSystem, getDesignSystem, recordBuiltFrom } from "../../../src/services/design/design-systems.service.ts";
import { designSystemStaleness, isThemeConfigFile, staleFromChangedPaths } from "../../../src/services/design/design-systems-stale.ts";

describe("isThemeConfigFile", () => {
  it("flags tailwind/postcss config and anything theme/tokens/variables by name", () => {
    for (const path of [
      "tailwind.config.js", "tailwind.config.ts", "postcss.config.cjs",
      "src/theme/index.ts", "src/tokens.css", "src/design-tokens.json", "src/variables.scss",
      "styles/_variables.scss", "theme/_partial.less",
    ]) {
      expect(isThemeConfigFile(path)).toBe(true);
    }
  });

  it("does not flag an ordinary component or util file", () => {
    for (const path of ["src/components/Button.tsx", "src/utils/format.ts", "src/App.css", "src/index.ts"]) {
      expect(isThemeConfigFile(path)).toBe(false);
    }
  });
});

describe("staleFromChangedPaths", () => {
  it("is stale on a single theme-file change, even with no other files touched", () => {
    expect(staleFromChangedPaths(["src/theme/colors.ts"])).toEqual({ stale: true, changedFiles: 1, unknown: false });
  });

  it("is stale at 20 changed UI files, not at 19", () => {
    const ui19 = Array.from({ length: 19 }, (_, i) => `src/c${i}.tsx`);
    expect(staleFromChangedPaths(ui19).stale).toBe(false);
    expect(staleFromChangedPaths([...ui19, "src/c19.tsx"]).stale).toBe(true);
  });

  it("does not count a non-UI extension toward the 20-file threshold", () => {
    const files = Array.from({ length: 25 }, (_, i) => `README${i}.md`);
    expect(staleFromChangedPaths(files)).toEqual({ stale: false, changedFiles: 25, unknown: false });
  });
});

function git(cwd: string, ...args: string[]) {
  return Bun.spawnSync(["git", ...args], { cwd });
}

describe("designSystemStaleness", () => {
  let project: string;
  let appRoot: string;
  beforeEach(() => {
    project = realpathSync(mkdtempSync(join(tmpdir(), "ppm-design-stale-")));
    appRoot = join(project, "payroll-fe");
    mkdirSync(appRoot, { recursive: true });
  });
  afterEach(() => rmSync(project, { recursive: true, force: true }));

  it("is unknown with no repo, or with a repo but no builtFrom recorded yet", async () => {
    const app = await createDesignSystem(project, { label: "Payroll", root: "payroll-fe", platform: "web" });
    expect(await designSystemStaleness(project, app)).toEqual({ stale: false, unknown: true });
  });

  it("is not stale right after builtFrom is recorded, and becomes stale after enough changes", async () => {
    if (git(appRoot, "init", "-q").exitCode !== 0) return; // no git on this host
    git(appRoot, "config", "user.email", "t@example.com");
    git(appRoot, "config", "user.name", "T");
    writeFileSync(join(appRoot, "a.ts"), "export const a = 1;\n");
    git(appRoot, "add", "-A");
    git(appRoot, "commit", "-q", "-m", "init");

    const declared = await createDesignSystem(project, { label: "Payroll", root: "payroll-fe", platform: "web" });
    await recordBuiltFrom(project, declared.id);
    const built = await getDesignSystem(project, declared.id);
    expect(await designSystemStaleness(project, built)).toEqual({ stale: false, changedFiles: 0, unknown: false });

    writeFileSync(join(appRoot, "theme.ts"), "export const theme = {};\n");
    git(appRoot, "add", "-A");
    git(appRoot, "commit", "-q", "-m", "theme change");
    const info = await designSystemStaleness(project, built);
    expect(info.unknown).toBe(false);
    expect(info.stale).toBe(true);
    expect(info.changedFiles).toBe(1);
  });
});
