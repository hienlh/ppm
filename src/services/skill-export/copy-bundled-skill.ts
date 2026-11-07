// Write the bundled skill package into a target directory.
// The package is embedded at build time, not read off disk beside this file: a compiled binary has
// no such file (`import.meta.url` is `$bunfs`), so `ppm export skill` failed on every release binary.
// Regenerate it with `bun run generate:skill`; a test checks this list against assets/skills/ppm.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import skillMd from "../../../assets/skills/ppm/SKILL.md" with { type: "text" };
import cliReference from "../../../assets/skills/ppm/references/cli-reference.md" with { type: "text" };
import commonTasks from "../../../assets/skills/ppm/references/common-tasks.md" with { type: "text" };
import httpApi from "../../../assets/skills/ppm/references/http-api.md" with { type: "text" };

/** Each file of the skill package, by its path inside the skill directory. */
export const BUNDLED_SKILL_FILES: Readonly<Record<string, string>> = {
  "SKILL.md": skillMd,
  "references/cli-reference.md": cliReference,
  "references/common-tasks.md": commonTasks,
  "references/http-api.md": httpApi,
};

export function copyBundledSkill(targetDir: string): string[] {
  const written: string[] = [];
  for (const [rel, content] of Object.entries(BUNDLED_SKILL_FILES)) {
    const dest = resolve(targetDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content, "utf-8");
    written.push(dest);
  }
  return written;
}
