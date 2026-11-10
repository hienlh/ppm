import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { BUNDLED_SKILL_FILES, copyBundledSkill } from "../../../src/services/skill-export/copy-bundled-skill.ts";

const ASSETS = resolve(import.meta.dir, "../../../assets/skills/ppm");
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Every file under `root`, as a `/`-separated path relative to it. */
function filesUnder(root: string, dir = root): string[] {
  return readdirSync(dir).flatMap((name) => {
    const abs = join(dir, name);
    return statSync(abs).isDirectory() ? filesUnder(root, abs) : [relative(root, abs).split(sep).join("/")];
  });
}

describe("the bundled skill package", () => {
  it("carries every file the generator wrote, as written", () => {
    expect(Object.keys(BUNDLED_SKILL_FILES).sort()).toEqual(filesUnder(ASSETS).sort());
    for (const [rel, content] of Object.entries(BUNDLED_SKILL_FILES)) {
      expect(content).toBe(readFileSync(join(ASSETS, rel), "utf-8"));
    }
  });

  it("is written into the target directory", () => {
    const target = mkdtempSync(join(tmpdir(), "ppm-skill-"));
    dirs.push(target);
    copyBundledSkill(target);
    expect(filesUnder(target).sort()).toEqual(Object.keys(BUNDLED_SKILL_FILES).sort());
    expect(readFileSync(join(target, "SKILL.md"), "utf-8")).toMatch(/^---\r?\nname: ppm\r?\n/);
  });
});
