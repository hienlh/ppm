/**
 * Manager chats: which chat PPM Assistant talks to about each project. The rules for the role
 * live here — one per project, one project per chat, a Claude chat of that same project that is
 * neither a design nor an Assistant session — and so does the in-memory answer to "is this chat a
 * manager", which is asked on every turn and dropped on every change.
 */
import { basename } from "node:path";
import { configService } from "../config.service.ts";
import {
  getSessionDesignSlug, getSessionProjectPath, getSessionProvider, resolveMigratedSession,
  setSessionMetadata, setSessionProvider,
} from "../db.service.ts";
import { projectKey } from "../project-name-for-path.ts";
import { isAssistantSession } from "../assistant/assistant-session.ts";
import { chatLifecycle } from "../chat-control/chat-lifecycle.ts";
import { providerRegistry } from "../../providers/registry.ts";
import { MANAGER_CLAUDE_ONLY, MANAGER_PROVIDER_ID } from "../../shared/assistant-managers.ts";
import {
  deleteManagerChatRow, deleteManagerChatRowsFor, getManagerChatRow, listManagerChatRows, patchManagerChatRow,
  putManagerChatRow, type ManagerChatPatch, type ManagerChatRow,
} from "./manager-chats-db.ts";

export class ManagerChatError extends Error {
  constructor(message: string, readonly status: 400 | 404 = 400) {
    super(message);
  }
}

export interface ManagerProject {
  name: string;
  path: string;
  key: string;
}

export interface ManagerChatsEnv {
  projects(): Array<{ name: string; path: string }>;
  /** Whether a Claude chat PPM holds no row for (one started in the CLI) is in this folder. */
  findClaudeSession(sessionId: string, projectPath: string): Promise<boolean>;
  /** Called after any change, with the projects it touched. */
  changed(projectNames: string[]): void;
  now(): number;
}

type SessionInfoById = { getSessionInfoById?: (id: string, dir?: string) => Promise<unknown | null> };

const realEnv: ManagerChatsEnv = {
  projects: () => configService.get("projects"),
  findClaudeSession: async (sessionId, projectPath) => {
    const provider = providerRegistry.get(MANAGER_PROVIDER_ID) as unknown as SessionInfoById | undefined;
    if (!provider?.getSessionInfoById) return false;
    try {
      return (await provider.getSessionInfoById(sessionId, projectPath)) != null;
    } catch {
      return false;
    }
  },
  // Loaded on use: the announcement reaches the chat registry and the global socket, which load
  // after the services that ask whether a chat is a manager.
  changed: (projectNames) => {
    void import("./manager-chats-announce.ts")
      .then(({ announceManagersChanged }) => announceManagersChanged(projectNames))
      .catch(() => { /* logged by the announcement */ });
  },
  now: () => Date.now(),
};

export function createManagerChats(env: ManagerChatsEnv = realEnv) {
  let cache: { byKey: Map<string, ManagerChatRow>; bySession: Map<string, string> } | null = null;
  const load = () => {
    if (!cache) {
      const rows = listManagerChatRows();
      cache = { byKey: new Map(rows.map((r) => [r.projectKey, r])), bySession: new Map(rows.map((r) => [r.sessionId, r.projectKey])) };
    }
    return cache;
  };
  const invalidate = () => { cache = null; };

  /**
   * The project by name. A project removed from PPM keeps its manager row until it is unassigned;
   * `allowGone` finds that row by the name the list shows for it (its folder's), so the role can
   * still be taken away or its settings changed. Assigning needs a registered project.
   */
  function project(name: string, allowGone = false): ManagerProject {
    const found = env.projects().find((p) => p.name === name);
    if (found) return { name: found.name, path: found.path, key: projectKey(found.path) };
    const gone = allowGone ? listManagerChatRows().find((r) => nameFor(r) === name) : undefined;
    if (gone) return { name, path: gone.projectPath, key: gone.projectKey };
    throw new ManagerChatError(`No project named "${name}"`, 404);
  }

  function nameFor(row: ManagerChatRow): string {
    return env.projects().find((p) => projectKey(p.path) === row.projectKey)?.name ?? basename(row.projectPath);
  }

  /** The chat as it may become `target`'s manager, or why it may not. Writes nothing. */
  async function check(target: ManagerProject, asked: string): Promise<{ sessionId: string; found: boolean }> {
    const sessionId = resolveMigratedSession(asked);
    if (isAssistantSession(sessionId)) throw new ManagerChatError("A PPM Assistant session cannot be a manager chat");
    if (getSessionDesignSlug(sessionId)) throw new ManagerChatError("A design chat cannot be a manager chat");
    const provider = getSessionProvider(sessionId) ?? getSessionProvider(asked);
    if (provider && provider !== MANAGER_PROVIDER_ID) throw new ManagerChatError(MANAGER_CLAUDE_ONLY);
    const stored = getSessionProjectPath(sessionId);
    if (stored) {
      if (projectKey(stored) !== target.key) throw new ManagerChatError(`That chat belongs to another project, not ${target.name}`);
      if (provider) return { sessionId, found: false };
    }
    // No row says where or on what the chat runs: only a Claude chat found in this folder will do.
    if (!(await env.findClaudeSession(sessionId, target.path))) {
      throw new ManagerChatError(`No Claude chat with that id in ${target.name}`, 404);
    }
    return { sessionId, found: true };
  }

  return {
    project,
    nameFor,
    list(): Array<ManagerChatRow & { projectName: string }> {
      return [...load().byKey.values()].map((r) => ({ ...r, projectName: nameFor(r) }));
    },
    /** The project's manager row, or null. */
    managerFor(projectPath: string): ManagerChatRow | null {
      return load().byKey.get(projectKey(projectPath)) ?? null;
    },
    isManagerChat(sessionId: string): boolean {
      const { bySession } = load();
      return bySession.has(sessionId) || (bySession.size > 0 && bySession.has(resolveMigratedSession(sessionId)));
    },
    /** The chat that assigning `sessionId` would replace, or why it cannot be assigned. */
    async checkAssign(projectName: string, sessionId: string) {
      const target = project(projectName);
      const { sessionId: current } = await check(target, sessionId);
      const existing = getManagerChatRow(target.key);
      return { target, sessionId: current, replaces: existing && existing.sessionId !== current ? existing : null };
    },
    async assign(projectName: string, sessionId: string, by: "user" | "assistant" = "user"): Promise<{ row: ManagerChatRow; replaced: string | null }> {
      const target = project(projectName);
      const { sessionId: current, found } = await check(target, sessionId);
      if (found) {
        setSessionMetadata(current, target.name, target.path);
        setSessionProvider(current, MANAGER_PROVIDER_ID);
      }
      const previous = getManagerChatRow(target.key);
      const touched = new Set([target.name]);
      for (const row of listManagerChatRows()) if (row.sessionId === current) touched.add(nameFor(row));
      putManagerChatRow({
        projectKey: target.key, projectPath: target.path, sessionId: current, providerId: MANAGER_PROVIDER_ID,
        assignedBy: by, assignedAt: env.now(),
      });
      invalidate();
      env.changed([...touched]);
      return { row: getManagerChatRow(target.key)!, replaced: previous && previous.sessionId !== current ? previous.sessionId : null };
    },
    /** Removes the role and nothing else: the chat keeps its history and mode. */
    unassign(projectName: string): boolean {
      const target = project(projectName, true);
      const removed = deleteManagerChatRow(target.key);
      invalidate();
      if (removed) env.changed([target.name]);
      return removed;
    },
    patch(projectName: string, patch: ManagerChatPatch): boolean {
      const target = project(projectName, true);
      // Nothing to change: say whether there is a manager, and announce nothing.
      if (patch.digest === undefined && patch.telegramDetail === undefined) return getManagerChatRow(target.key) !== null;
      const done = patchManagerChatRow(target.key, patch);
      invalidate();
      if (done) env.changed([target.name]);
      return done;
    },
    /** Drops the cached answers; the next question reads the table again. */
    invalidate,
    /** A deleted chat stops being a manager. */
    forgetSession(sessionId: string): void {
      const before = listManagerChatRows();
      const keys = deleteManagerChatRowsFor(sessionId);
      invalidate();
      if (keys.length === 0) return;
      env.changed(before.filter((r) => keys.includes(r.projectKey)).map(nameFor));
    },
  };
}

export type ManagerChats = ReturnType<typeof createManagerChats>;

export const managerChats = createManagerChats();

// A provider renaming a session (Codex's first turn) changes the id the cache is keyed by.
chatLifecycle.on("migrated", () => managerChats.invalidate());
