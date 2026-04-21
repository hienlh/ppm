import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { generateSkillMd } from "../../../scripts/lib/generate-skill-md.ts";

const dirs: string[] = [];

function makeFakeRoot(): string {
  const root = mkdtempSync(resolve(tmpdir(), "ppm-genmd-"));
  dirs.push(root);
  mkdirSync(resolve(root, "templates/skill"), { recursive: true });
  writeFileSync(
    resolve(root, "templates/skill/SKILL.md.tmpl"),
    "---\nname: ppm\n---\n\n# Test\n\n<!-- AUTO:version_footer -->\n",
  );
  writeFileSync(resolve(root, "package.json"), JSON.stringify({ version: "9.9.9" }));
  return root;
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe("generateSkillMd", () => {
  it("substitutes the version footer placeholder", () => {
    const root = makeFakeRoot();
    const result = generateSkillMd(root);

    expect(result).toHaveLength(1);
    expect(result[0]!.relPath).toBe("SKILL.md");
    expect(result[0]!.content).toContain("PPM v9.9.9");
    expect(result[0]!.content).not.toContain("<!-- AUTO:version_footer -->");
  });

  it("preserves frontmatter from template", () => {
    const root = makeFakeRoot();
    const result = generateSkillMd(root);
    expect(result[0]!.content).toStartWith("---\nname: ppm\n---");
  });

  it("falls back to stub when template missing", () => {
    const root = mkdtempSync(resolve(tmpdir(), "ppm-genmd-noTmpl-"));
    dirs.push(root);
    writeFileSync(resolve(root, "package.json"), JSON.stringify({ version: "1.0.0" }));

    const result = generateSkillMd(root);
    expect(result[0]!.content).toContain("name: ppm");
    expect(result[0]!.content).toContain("Stub");
  });
});
