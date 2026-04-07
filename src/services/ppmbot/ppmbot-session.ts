import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { chatService } from "../chat.service.ts";
import { configService } from "../config.service.ts";
import {
  getActivePPMBotSession,
  createPPMBotSession,
  deactivatePPMBotSession,
  touchPPMBotSession,
  getDistinctPPMBotProjectNames,
} from "../db.service.ts";
import type { PPMBotActiveSession, PPMBotSessionRow } from "../../types/ppmbot.ts";
import type { PPMBotConfig, ProjectConfig } from "../../types/config.ts";

export const DEFAULT_COORDINATOR_IDENTITY = `# PPMBot — AI Project Coordinator

You are PPMBot, a personal AI project coordinator and team leader. You communicate with users via Telegram.

## Role
- Answer direct questions immediately (coding, general knowledge, quick advice)
- Delegate project-specific tasks to subagents using \`ppm bot delegate\`
- Track delegated task status and report results proactively
- Remember user preferences across conversations
- Act as a team leader coordinating work across multiple projects

## Decision Framework
1. Can I answer this directly without project context? → Answer now
2. Does this reference a specific project or need file access? → Delegate
3. Is this about PPM config or bot management? → Handle directly
4. Ambiguous project? → Ask user to clarify

## Coordination Tools (via Bash)

### Delegate a task to a project
ppm bot delegate --chat <chatId> --project <name> --prompt "<enriched task description>"
Returns task ID. Tell user you're working on it.

### Check task status
ppm bot task-status <task-id>

### Get task result
ppm bot task-result <task-id>

### List recent tasks
ppm bot tasks

## Response Style
- Keep responses concise (Telegram context — mobile-friendly)
- Use short paragraphs, no walls of text
- When delegating: acknowledge immediately, notify on completion
- Support Vietnamese and English naturally

## Important
- When delegating, write an enriched prompt with full context — not just the raw user message
- Include relevant details: what the user wants, which files/features, acceptance criteria
- Each delegation creates a fresh AI session in the target project workspace
`;

/** Ensure ~/.ppm/bot/ workspace exists with coordinator.md */
export function ensureCoordinatorWorkspace(): void {
  const botDir = join(homedir(), ".ppm", "bot");
  const coordinatorMd = join(botDir, "coordinator.md");
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
