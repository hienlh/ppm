// Phase 4 populates. Phase 1 stub returns a placeholder SKILL.md.
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { OutputFile } from "./write-output.ts";

export function generateSkillMd(root: string): OutputFile[] {
  const tmplPath = resolve(root, "templates/skill/SKILL.md.tmpl");
  if (existsSync(tmplPath)) {
    const tmpl = readFileSync(tmplPath, "utf-8");
    const pkgJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf-8")) as { version: string };
    const footer = `<!-- Generated for PPM v${pkgJson.version} at build time. Re-run \`ppm export skill --install\` to refresh. -->`;
    const content = tmpl.replace("<!-- AUTO:version_footer -->", footer);
    return [{ relPath: "SKILL.md", content }];
  }
  // Stub fallback when template not yet authored (used during phase 1)
  const stub = [
    "---",
    "name: ppm",
    "description: Control PPM via CLI, HTTP API, and SQLite config DB.",
    "---",
    "",
    "# PPM Skill",
    "",
    "_Stub — template pending (phase 4)._",
    "",
  ].join("\n");
  return [{ relPath: "SKILL.md", content: stub }];
}
