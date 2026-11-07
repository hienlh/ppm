// `ppm export skill` — install bundled skill package to ~/.claude/skills/ppm/ (Codex: ~/.agents/skills/ppm/,
// Antigravity: ~/.gemini/config/skills/ppm/, or a custom path) so AI agents can control PPM.
import type { Command } from "commander";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  resolveTargetDir,
  backupExisting,
  copyBundledSkill,
  BUNDLED_SKILL_FILES,
  generateDbSchemaMarkdown,
  type SkillScope,
} from "../../services/skill-export/index.ts";

interface ExportSkillOpts {
  install?: boolean;
  scope: SkillScope;
  output?: string;
  format: string;
}

export function registerExportCommands(program: Command): void {
  const exp = program
    .command("export")
    .description("Export PPM metadata for external tools (AI agents, editors)");

  exp
    .command("skill")
    .description("Export skill for controlling PPM from AI agents (Claude Code, Codex, Antigravity)")
    .option("--install", "Install to target dir (default scope=user → ~/.claude/skills/ppm/, ~/.agents/skills/ppm/ or ~/.gemini/config/skills/ppm/)")
    .option("--scope <scope>", "Install scope: user | project", "user")
    .option("--output <dir>", "Custom output directory (overrides --scope)")
    .option("--format <fmt>", "Output format: claude-code | codex | antigravity", "claude-code")
    .action(async (opts: ExportSkillOpts) => {
      if (opts.format !== "claude-code" && opts.format !== "codex" && opts.format !== "antigravity") {
        console.error(`Unsupported format: ${opts.format}. Supported formats: 'claude-code', 'codex', 'antigravity'.`);
        process.exit(1);
      }
      if (opts.scope && opts.scope !== "user" && opts.scope !== "project") {
        console.error(`Invalid scope: ${opts.scope}. Use 'user' or 'project'.`);
        process.exit(1);
      }

      // Preview mode: print merged SKILL.md to stdout.
      if (!opts.install && !opts.output) {
        process.stdout.write(BUNDLED_SKILL_FILES["SKILL.md"]!);
        return;
      }

      const target = resolveTargetDir({ scope: opts.scope, output: opts.output, format: opts.format });

      try {
        const backedUp = backupExisting(target);
        mkdirSync(target, { recursive: true });
        copyBundledSkill(target);

        // Runtime DB schema (reads ~/.ppm/ppm.db readonly)
        const refsDir = resolve(target, "references");
        mkdirSync(refsDir, { recursive: true });
        writeFileSync(resolve(refsDir, "db-schema.md"), generateDbSchemaMarkdown(), "utf-8");

        console.log(`✓ Installed PPM skill → ${target}`);
        if (backedUp.length > 0) {
          console.log(`  Backed up ${backedUp.length} existing file(s) with .bak-<timestamp> suffix.`);
          console.log(`  Safe to delete those backups if not needed.`);
        }
        if (!existsSync(resolve(target, "SKILL.md"))) {
          console.error("Post-install verification failed: SKILL.md missing in target.");
          process.exit(1);
        }
      } catch (e) {
        console.error(`Install failed: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    });
}
