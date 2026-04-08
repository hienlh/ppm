import { existsSync, mkdirSync, readFileSync as fsRead, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { chatService } from "../chat.service.ts";
import { configService } from "../config.service.ts";
import { VERSION } from "../../version.ts";
import {
  getActivePPMBotSession,
  createPPMBotSession,
  deactivatePPMBotSession,
  touchPPMBotSession,
  getDistinctPPMBotProjectNames,
} from "../db.service.ts";
import { DEFAULT_CLI_REFERENCE } from "./cli-reference-default.ts";
import type { PPMBotActiveSession, PPMBotSessionRow } from "../../types/ppmbot.ts";
import type { PPMBotConfig, ProjectConfig } from "../../types/config.ts";

export const DEFAULT_COORDINATOR_IDENTITY = `# PPMBot — AI Project Coordinator

You are PPMBot, a personal AI project coordinator and team leader. You communicate with users via Telegram and have full control over PPM through CLI commands.

## Role
- Answer direct questions immediately (coding, general knowledge, quick advice)
- Delegate project-specific tasks to subagents using \`ppm bot delegate\`
- Track delegated task status and report results proactively
- Manage PPM server, projects, config, git, cloud, extensions, and databases
- Remember user preferences across conversations

## Decision Framework
1. Can I answer this directly without project context? → Answer now
2. Does this reference a specific project or need file access? → Delegate with \`ppm bot delegate\`
3. Is this about PPM management (server/config/projects/git/db/cloud/ext)? → Use CLI commands directly
4. Is this a destructive operation? → Confirm with user first
5. Ambiguous project? → Ask user to clarify

## Safety Rules (CRITICAL)
Before executing destructive commands, ALWAYS confirm with the user:
- \`ppm stop\` / \`ppm down\` / \`ppm restart\` → "Are you sure you want to stop/restart PPM?"
- \`ppm db query\` with writes → warn about data modification risk
- \`ppm projects remove\` → confirm project name
- \`ppm config set\` → show current value with \`ppm config get\` BEFORE changing
- \`ppm cloud logout\` / \`ppm cloud unlink\` → confirm
- \`ppm git branch delete\` → warn about potential data loss
- \`ppm ext remove\` → confirm extension name

## Operational Patterns
- Before restart: check \`ppm status\` first
- Before config change: read current with \`ppm config get <key>\`
- Before git push: check \`ppm git status --project <name>\`
- For DB operations: always specify connection name
- For git operations: always use \`--project <name>\` flag

## CLI Commands
Full CLI reference is in \`cli-reference.md\` (auto-injected into context).

## Response Style
- Keep responses concise (Telegram — mobile-friendly)
- Short paragraphs, no walls of text
- When delegating: acknowledge immediately, notify on completion
- Support Vietnamese and English naturally

## Important
- When delegating, write enriched prompts with full context — not just raw user message
- Include: what user wants, which files/features, acceptance criteria
- Each delegation creates a fresh AI session in the target project workspace
- Use \`--json\` flag when parsing command output programmatically
`;

/** Ensure ~/.ppm/bot/ workspace exists with coordinator.md + cli-reference.md */
export function ensureCoordinatorWorkspace(): void {
  const botDir = join(homedir(), ".ppm", "bot");
  const coordinatorMd = join(botDir, "coordinator.md");
  const cliRefPath = join(botDir, "cli-reference.md");
  const settingsDir = join(botDir, ".claude");
  const settingsFile = join(settingsDir, "settings.local.json");

  mkdirSync(botDir, { recursive: true });
  mkdirSync(settingsDir, { recursive: true });

  if (!existsSync(coordinatorMd)) {
    writeFileSync(coordinatorMd, DEFAULT_COORDINATOR_IDENTITY);
  }
  if (!existsSync(settingsFile)) {
    writeFileSync(settingsFile, JSON.stringify({
      permissions: { allow: ["Bash", "Read", "Write", "Edit", "Glob", "Grep"] },
    }, null, 2));
  }

  // Auto-generate cli-reference.md if missing or version mismatch
  ensureCliReference(cliRefPath);
}

/** Read CLI reference from disk (for context injection) */
export function readCliReference(): string {
  const cliRefPath = join(homedir(), ".ppm", "bot", "cli-reference.md");
  try {
    return fsRead(cliRefPath, "utf-8");
  } catch {
    return "";
  }
}

/**
 * Generate cli-reference.md if missing or version differs.
 * Embeds version header: `<!-- ppm-version: x.x.x -->`
 */
function ensureCliReference(cliRefPath: string): void {
  // Check existing version
  if (existsSync(cliRefPath)) {
    try {
      const existing = fsRead(cliRefPath, "utf-8");
      const versionMatch = existing.match(/<!-- ppm-version: (.+?) -->/);
      if (versionMatch && versionMatch[1] === VERSION) return; // up to date
    } catch { /* regenerate on read error */ }
  }

  try {
    const content = generateCliReference();
    writeFileSync(cliRefPath, content);
    console.log(`[ppmbot] Generated cli-reference.md (v${VERSION})`);
  } catch (err) {
    console.warn(`[ppmbot] Failed to generate cli-reference.md:`, (err as Error).message);
  }
}

/** Generate CLI reference by running the generator script */
function generateCliReference(): string {
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
  const scriptPath = join(import.meta.dir, "../../../scripts/generate-bot-coordinator.ts");

  // If generator script exists (dev/source install), run it
  if (existsSync(scriptPath)) {
    const result = spawnSync("bun", [scriptPath, "--cli-only"], {
      cwd: join(import.meta.dir, "../../.."),
      timeout: 10_000,
      encoding: "utf-8",
    });
    if (result.status === 0 && result.stdout) {
      return `<!-- ppm-version: ${VERSION} -->\n${result.stdout}`;
    }
  }

  // Fallback: generate from bundled constant
  return `<!-- ppm-version: ${VERSION} -->\n${DEFAULT_CLI_REFERENCE}`;
}

export class PPMBotSessionManager {
  /** In-memory cache: telegramChatId → coordinator session */
  private coordinatorSessions = new Map<string, PPMBotActiveSession>();

  /** Get or create coordinator session for chatId (always ~/.ppm/bot/) */
  async getCoordinatorSession(chatId: string): Promise<PPMBotActiveSession> {
    const cached = this.coordinatorSessions.get(chatId);
    if (cached) {
      touchPPMBotSession(cached.sessionId);
      return cached;
    }

    // Check DB for existing coordinator session
    const dbSession = getActivePPMBotSession(chatId, "bot");
    if (dbSession) {
      return this.resumeFromDb(chatId, dbSession);
    }

    return this.createCoordinatorSession(chatId);
  }

  /** Rotate coordinator session (context window near limit) */
  async rotateCoordinatorSession(chatId: string): Promise<PPMBotActiveSession> {
    const old = this.coordinatorSessions.get(chatId);
    if (old) deactivatePPMBotSession(old.sessionId);
    this.coordinatorSessions.delete(chatId);
    return this.createCoordinatorSession(chatId);
  }

  /**
   * Resolve a project name against configured projects.
   * Case-insensitive, supports prefix matching.
   */
  resolveProject(input: string): { name: string; path: string } | null {
    const projects = configService.get("projects") as ProjectConfig[];
    if (!projects?.length) return null;

    const lower = input.toLowerCase();
    const exact = projects.find((p) => p.name.toLowerCase() === lower);
    if (exact) return { name: exact.name, path: exact.path };

    const prefix = projects.filter((p) => p.name.toLowerCase().startsWith(lower));
    if (prefix.length === 1) return { name: prefix[0]!.name, path: prefix[0]!.path };

    return null;
  }

  /** Get list of available project names (config + sessions history) */
  getProjectNames(): string[] {
    const configured = (configService.get("projects") as ProjectConfig[])?.map((p) => p.name) ?? [];
    const fromSessions = getDistinctPPMBotProjectNames();
    const merged = new Set([...configured, ...fromSessions]);
    return [...merged].sort();
  }

  // ── Private ─────────────────────────────────────────────────────

  private getCoordinatorProject(): { name: string; path: string } {
    const botDir = join(homedir(), ".ppm", "bot");
    if (!existsSync(botDir)) mkdirSync(botDir, { recursive: true });
    return { name: "bot", path: botDir };
  }

  private getDefaultProvider(): string {
    const cfg = configService.get("clawbot") as PPMBotConfig | undefined;
    return cfg?.default_provider || configService.get("ai").default_provider;
  }

  private async createCoordinatorSession(chatId: string): Promise<PPMBotActiveSession> {
    const project = this.getCoordinatorProject();
    const providerId = this.getDefaultProvider();

    const session = await chatService.createSession(providerId, {
      projectName: project.name,
      projectPath: project.path,
      title: `[PPM] Coordinator`,
    });

    createPPMBotSession(chatId, session.id, providerId, project.name, project.path);

    const active: PPMBotActiveSession = {
      telegramChatId: chatId,
      sessionId: session.id,
      providerId,
      projectName: project.name,
      projectPath: project.path,
    };

    this.coordinatorSessions.set(chatId, active);
    return active;
  }

  private async resumeFromDb(chatId: string, dbSession: PPMBotSessionRow): Promise<PPMBotActiveSession> {
    const project = this.getCoordinatorProject();

    try {
      await chatService.resumeSession(dbSession.provider_id, dbSession.session_id);
    } catch {
      console.warn(`[ppmbot] Failed to resume session ${dbSession.session_id}, creating new`);
      deactivatePPMBotSession(dbSession.session_id);
      return this.createCoordinatorSession(chatId);
    }

    touchPPMBotSession(dbSession.session_id);

    const active: PPMBotActiveSession = {
      telegramChatId: chatId,
      sessionId: dbSession.session_id,
      providerId: dbSession.provider_id,
      projectName: project.name,
      projectPath: project.path,
    };

    this.coordinatorSessions.set(chatId, active);
    return active;
  }
}
