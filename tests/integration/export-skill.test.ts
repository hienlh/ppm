import { describe, it, expect, beforeAll, afterEach } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

const tmpDirs: string[] = [];
const REPO_ROOT = resolve(import.meta.dir, "../..");
const CLI = `bun ${resolve(REPO_ROOT, "src/index.ts")}`;

function mkTmp(prefix: string): string {
  const d = mkdtempSync(resolve(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

// Ensure bundled skill assets exist before integration flow runs.
beforeAll(() => {
  const assetsSkillMd = resolve(REPO_ROOT, "assets/skills/ppm/SKILL.md");
  if (!existsSync(assetsSkillMd)) {
    execSync("bun run generate:skill", { cwd: REPO_ROOT, stdio: "pipe" });
  }
});

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe("ppm export skill (integration)", () => {
  it("--install --output <tmp> creates full skill tree", () => {
    const out = mkTmp("ppm-exp-");
    execSync(`${CLI} export skill --install --output ${out}`, { stdio: "pipe" });

    expect(existsSync(resolve(out, "SKILL.md"))).toBe(true);
    expect(existsSync(resolve(out, "references/cli-reference.md"))).toBe(true);
    expect(existsSync(resolve(out, "references/http-api.md"))).toBe(true);
    expect(existsSync(resolve(out, "references/common-tasks.md"))).toBe(true);
    expect(existsSync(resolve(out, "references/db-schema.md"))).toBe(true);

    const skill = readFileSync(resolve(out, "SKILL.md"), "utf-8");
    expect(skill).toContain("name: ppm");
    expect(skill).toContain("description:");
  });

  it("re-install creates .bak-* backups (no data loss)", () => {
    const out = mkTmp("ppm-exp-rerun-");
    // First install
    execSync(`${CLI} export skill --install --output ${out}`, { stdio: "pipe" });
    // Mutate a file so we can detect backup
    writeFileSync(resolve(out, "SKILL.md"), "CUSTOM");

    // Sleep 1s to force a different timestamp in the backup filename
    execSync("sleep 1");

    execSync(`${CLI} export skill --install --output ${out}`, { stdio: "pipe" });

    const files = readdirSync(out);
    const backupSkill = files.find((f) => f.startsWith("SKILL.md.bak-"));
    expect(backupSkill).toBeDefined();
    expect(readFileSync(resolve(out, backupSkill!), "utf-8")).toBe("CUSTOM");

    // New SKILL.md exists and is not "CUSTOM"
    const newSkill = readFileSync(resolve(out, "SKILL.md"), "utf-8");
    expect(newSkill).not.toBe("CUSTOM");
    expect(newSkill).toContain("name: ppm");
  });

  it("preview mode (no --install / --output) writes SKILL.md to stdout", () => {
    const stdout = execSync(`${CLI} export skill`, { stdio: "pipe" }).toString();
    expect(stdout).toContain("name: ppm");
    expect(stdout).toContain("# PPM Skill");
  });

  it("unsupported --format returns non-zero exit", () => {
    const out = mkTmp("ppm-exp-fmt-");
    let exitCode = 0;
    try {
      execSync(`${CLI} export skill --install --output ${out} --format cursor`, { stdio: "pipe" });
    } catch (e) {
      exitCode = (e as { status?: number }).status ?? 1;
    }
    expect(exitCode).not.toBe(0);
  });

  it("exposes `export` in top-level --help", () => {
    const stdout = execSync(`${CLI} --help`, { stdio: "pipe" }).toString();
    expect(stdout).toContain("export");
  });
});
