// Resolve the install target directory based on scope/output flags.
// Precedence: --output > --scope project > --scope user (default).
import { resolve } from "node:path";
import { homedir } from "node:os";

export type SkillScope = "user" | "project";

export interface ResolveTargetOpts {
  scope?: SkillScope;
  output?: string;
}

export function resolveTargetDir(opts: ResolveTargetOpts): string {
  if (opts.output) return resolve(opts.output);
  if (opts.scope === "project") return resolve(process.cwd(), ".claude/skills/ppm");
  return resolve(homedir(), ".claude/skills/ppm");
}
