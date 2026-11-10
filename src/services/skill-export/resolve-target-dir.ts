// Resolve the install target directory based on scope/output flags.
// Precedence: --output > --scope project > --scope user (default).
import { resolve } from "node:path";
import { homedir } from "node:os";

export type SkillScope = "user" | "project";
export type SkillFormat = "claude-code" | "codex" | "antigravity";

export interface ResolveTargetOpts {
  scope?: SkillScope;
  output?: string;
  format?: SkillFormat;
}

export function resolveTargetDir(opts: ResolveTargetOpts): string {
  if (opts.output) return resolve(opts.output);
  // Codex's user folder is ~/.agents/skills, not $CODEX_HOME/skills: every Codex account PPM runs has
  // a CODEX_HOME of its own, and this is the folder they all read (see design-skill-install.service.ts).
  if (opts.format === "codex") {
    if (opts.scope === "project") return resolve(process.cwd(), ".agents/skills/ppm");
    return resolve(homedir(), ".agents/skills/ppm");
  }
  if (opts.format === "antigravity") {
    if (opts.scope === "project") return resolve(process.cwd(), ".agents/skills/ppm");
    return resolve(homedir(), ".gemini/config/skills/ppm");
  }
  if (opts.scope === "project") return resolve(process.cwd(), ".claude/skills/ppm");
  return resolve(homedir(), ".claude/skills/ppm");
}
