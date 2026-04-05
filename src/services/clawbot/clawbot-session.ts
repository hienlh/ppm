import { chatService } from "../chat.service.ts";
import { configService } from "../config.service.ts";
import {
  getActiveClawBotSession,
  createClawBotSession,
  deactivateClawBotSession,
  touchClawBotSession,
  getRecentClawBotSessions,
  setSessionTitle,
} from "../db.service.ts";
import type { ClawBotActiveSession, ClawBotSessionRow } from "../../types/clawbot.ts";
import type { ClawBotConfig, ProjectConfig } from "../../types/config.ts";

export class ClawBotSessionManager {
  /** In-memory cache: telegramChatId → active session */
  private activeSessions = new Map<string, ClawBotActiveSession>();

  /**
   * Get active session for chatId. If none exists, create one for the
   * given project (or default project from config).
   */
  async getOrCreateSession(
    chatId: string,
    projectName?: string,
  ): Promise<ClawBotActiveSession> {
    const cached = this.activeSessions.get(chatId);
    if (cached && (!projectName || cached.projectName === projectName)) {
      touchClawBotSession(cached.sessionId);
      return cached;
    }

    const resolvedProject = this.resolveProject(
      projectName || this.getDefaultProject(),
    );
    if (!resolvedProject) {
      throw new Error(`Project not found: "${projectName || "(default)"}"`);
    }

    const dbSession = getActiveClawBotSession(chatId, resolvedProject.name);
    if (dbSession) {
      return this.resumeFromDb(chatId, dbSession, resolvedProject);
    }

    return this.createNewSession(chatId, resolvedProject);
  }

  /** Switch to a different project. Deactivates current session. */
  async switchProject(
    chatId: string,
    projectName: string,
  ): Promise<ClawBotActiveSession> {
    await this.closeSession(chatId);
    return this.getOrCreateSession(chatId, projectName);
  }

  /** Close (deactivate) the current session for a chatId */
  async closeSession(chatId: string): Promise<void> {
    const active = this.activeSessions.get(chatId);
    if (active) {
      deactivateClawBotSession(active.sessionId);
      this.activeSessions.delete(chatId);
    }
  }

  /** Get active session from cache (no DB hit) */
  getActiveSession(chatId: string): ClawBotActiveSession | null {
    return this.activeSessions.get(chatId) ?? null;
  }

  /** List recent sessions for a chat (from DB) */
  listRecentSessions(chatId: string, limit = 10): ClawBotSessionRow[] {
    return getRecentClawBotSessions(chatId, limit);
  }

  /** Resume a specific session by 1-indexed position in history */
  async resumeSessionById(
    chatId: string,
    sessionIndex: number,
  ): Promise<ClawBotActiveSession | null> {
    const sessions = getRecentClawBotSessions(chatId, 20);
    const target = sessions[sessionIndex - 1];
    if (!target) return null;

    await this.closeSession(chatId);

    const project = this.resolveProject(target.project_name);
    if (!project) return null;

    return this.resumeFromDb(chatId, target, project);
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

  /** Update session title (e.g. after first message) */
  updateSessionTitle(sessionId: string, firstMessage: string): void {
    const preview = firstMessage.slice(0, 60).replace(/\n/g, " ");
    const title = `[Claw] ${preview}`;
    setSessionTitle(sessionId, title);
  }

  /** Get list of available project names (for /start greeting) */
  getProjectNames(): string[] {
    const projects = configService.get("projects") as ProjectConfig[];
    return projects?.map((p) => p.name) ?? [];
  }

  // ── Private ─────────────────────────────────────────────────────

  private getDefaultProject(): string {
    const clawbot = configService.get("clawbot") as ClawBotConfig | undefined;
    return clawbot?.default_project || "";
  }

  private getDefaultProvider(): string {
    const clawbot = configService.get("clawbot") as ClawBotConfig | undefined;
    return clawbot?.default_provider || configService.get("ai").default_provider;
  }

  private async createNewSession(
    chatId: string,
    project: { name: string; path: string },
  ): Promise<ClawBotActiveSession> {
    const providerId = this.getDefaultProvider();

    const session = await chatService.createSession(providerId, {
      projectName: project.name,
      projectPath: project.path,
      title: `[Claw] New session`,
    });

    createClawBotSession(chatId, session.id, providerId, project.name, project.path);

    const active: ClawBotActiveSession = {
      telegramChatId: chatId,
      sessionId: session.id,
      providerId,
      projectName: project.name,
      projectPath: project.path,
    };

    this.activeSessions.set(chatId, active);
    return active;
  }

  private async resumeFromDb(
    chatId: string,
    dbSession: ClawBotSessionRow,
    project: { name: string; path: string },
  ): Promise<ClawBotActiveSession> {
    try {
      await chatService.resumeSession(dbSession.provider_id, dbSession.session_id);
    } catch {
      console.warn(`[clawbot] Failed to resume session ${dbSession.session_id}, creating new`);
      deactivateClawBotSession(dbSession.session_id);
      return this.createNewSession(chatId, project);
    }

    touchClawBotSession(dbSession.session_id);

    const active: ClawBotActiveSession = {
      telegramChatId: chatId,
      sessionId: dbSession.session_id,
      providerId: dbSession.provider_id,
      projectName: project.name,
      projectPath: project.path,
    };

    this.activeSessions.set(chatId, active);
    return active;
  }
}
