import { chatService } from "../chat.service.ts";
import { configService } from "../config.service.ts";
import {
  getActivePPMBotSession,
  createPPMBotSession,
  deactivatePPMBotSession,
  touchPPMBotSession,
  getRecentPPMBotSessions,
  setSessionTitle,
} from "../db.service.ts";
import type { PPMBotActiveSession, PPMBotSessionRow } from "../../types/ppmbot.ts";
import type { PPMBotConfig, ProjectConfig } from "../../types/config.ts";

export class PPMBotSessionManager {
  /** In-memory cache: telegramChatId → active session */
  private activeSessions = new Map<string, PPMBotActiveSession>();

  /**
   * Get active session for chatId. If none exists, create one for the
   * given project (or default project from config).
   */
  async getOrCreateSession(
    chatId: string,
    projectName?: string,
  ): Promise<PPMBotActiveSession> {
    const cached = this.activeSessions.get(chatId);
    if (cached && (!projectName || cached.projectName === projectName)) {
      touchPPMBotSession(cached.sessionId);
      return cached;
    }

    const resolvedProject = this.resolveProject(
      projectName || this.getDefaultProject(),
    );
    if (!resolvedProject) {
      throw new Error(`Project not found: "${projectName || "(default)"}"`);
    }

    const dbSession = getActivePPMBotSession(chatId, resolvedProject.name);
    if (dbSession) {
      return this.resumeFromDb(chatId, dbSession, resolvedProject);
    }

    return this.createNewSession(chatId, resolvedProject);
  }

  /** Switch to a different project. Deactivates current session. */
  async switchProject(
    chatId: string,
    projectName: string,
  ): Promise<PPMBotActiveSession> {
    await this.closeSession(chatId);
    return this.getOrCreateSession(chatId, projectName);
  }

  /** Close (deactivate) the current session for a chatId */
  async closeSession(chatId: string): Promise<void> {
    const active = this.activeSessions.get(chatId);
    if (active) {
      deactivatePPMBotSession(active.sessionId);
      this.activeSessions.delete(chatId);
    }
  }

  /** Get active session from cache (no DB hit) */
  getActiveSession(chatId: string): PPMBotActiveSession | null {
    return this.activeSessions.get(chatId) ?? null;
  }

  /** List recent sessions for a chat (from DB) */
  listRecentSessions(chatId: string, limit = 10): PPMBotSessionRow[] {
    return getRecentPPMBotSessions(chatId, limit);
  }

  /** Resume a specific session by 1-indexed position in history */
  async resumeSessionById(
    chatId: string,
    sessionIndex: number,
  ): Promise<PPMBotActiveSession | null> {
    const sessions = getRecentPPMBotSessions(chatId, 20);
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
    const title = `[PPM] ${preview}`;
    setSessionTitle(sessionId, title);
  }

  /** Get list of available project names (for /start greeting) */
  getProjectNames(): string[] {
    const projects = configService.get("projects") as ProjectConfig[];
    return projects?.map((p) => p.name) ?? [];
  }

  // ── Private ─────────────────────────────────────────────────────

  private getDefaultProject(): string {
    const cfg = configService.get("clawbot") as PPMBotConfig | undefined;
    return cfg?.default_project || "";
  }

  private getDefaultProvider(): string {
    const cfg = configService.get("clawbot") as PPMBotConfig | undefined;
    return cfg?.default_provider || configService.get("ai").default_provider;
  }

  private async createNewSession(
    chatId: string,
    project: { name: string; path: string },
  ): Promise<PPMBotActiveSession> {
    const providerId = this.getDefaultProvider();

    const session = await chatService.createSession(providerId, {
      projectName: project.name,
      projectPath: project.path,
      title: `[PPM] New session`,
    });

    createPPMBotSession(chatId, session.id, providerId, project.name, project.path);

    const active: PPMBotActiveSession = {
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
    dbSession: PPMBotSessionRow,
    project: { name: string; path: string },
  ): Promise<PPMBotActiveSession> {
    try {
      await chatService.resumeSession(dbSession.provider_id, dbSession.session_id);
    } catch {
      console.warn(`[ppmbot] Failed to resume session ${dbSession.session_id}, creating new`);
      deactivatePPMBotSession(dbSession.session_id);
      return this.createNewSession(chatId, project);
    }

    touchPPMBotSession(dbSession.session_id);

    const active: PPMBotActiveSession = {
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
