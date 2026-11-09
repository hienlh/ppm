import { resolve } from "node:path";
import { renameSession as sdkRenameSession } from "@anthropic-ai/claude-agent-sdk";
import {
  getSessionDesignSlug, getSessionModel, getSessionProjectPath, getSessionProvider, getStoredPermissionModeAnyAlias,
  getSessionTitle, resolveMigratedSession, sessionIdAliases, setSessionMetadata, setSessionModel,
  setSessionPermissionMode, setSessionTitle,
} from "../db.service.ts";
import { configService } from "../config.service.ts";
import { chatService } from "../chat.service.ts";
import { createLogger } from "../logger.ts";
import { providerRegistry } from "../../providers/registry.ts";
import { listSessionTurns } from "../session-turns/session-turn-index.service.ts";
import { resolveSessionCollabSettings } from "../../shared/session-collab-settings.ts";
import type { TurnReference } from "../../shared/chat-turn-ref.ts";
import {
  announceSessionCreated, announceSessionLinkChanged, deliverToSession, waitForTurnBinding,
} from "../../server/ws/chat-inject.ts";
import { collabLiveState, listRunningSessions, onTurnBinding } from "../../server/ws/chat.ts";
import { collabApprovalBroker } from "./collab-approval-broker.ts";
import type { CollabCaller, CollabEnv } from "./collab-context.ts";
import { collabWaits } from "./collab-waits.ts";
import { collabUnread } from "./collab-unread.ts";
import { markChildStarting, reserveChildSlot, reservedChildSlots, startingChildren } from "./collab-turn-events.ts";
import { pairCounter } from "./pair-counter.ts";
import { childrenOf, depthOf, isSpawned, linkedSessions, parentOf, recordSpawn } from "./session-links.service.ts";

/**
 * The session tools' {@link CollabEnv} as the running server provides it. Lookups that may meet an
 * id a provider has since replaced walk every alias the session had; nothing here reads a Codex
 * rollout, and a transcript is read only for the caller's own Claude turn reference.
 */

const log = createLogger("session-collab");

/** How long a created session's provider name waits for its first turn to have a transcript. */
const NAME_WAIT_MS = 2 * 60_000;
const PROMPT_CHARS = 300;

const firstOf = <T>(sessionId: string, read: (id: string) => T | null): T | null => {
  for (const id of sessionIdAliases(sessionId)) {
    const value = read(id);
    if (value !== null && value !== undefined) return value;
  }
  return null;
};

// A provider naming the turn a delivered message went into settles the "did it read it" question.
onTurnBinding((binding) => {
  if (!binding.clientMessageId) return;
  collabWaits.turnBound(binding.clientMessageId);
  collabUnread.turnBound(binding.clientMessageId);
});

async function claudeTurnRef(caller: CollabCaller): Promise<TurnReference | null> {
  // A Codex session's turn index means locating its rollout; the from-session block names the turn instead.
  if (caller.providerId !== "claude") return null;
  const { turns } = await listSessionTurns({ providerId: "claude", sessionId: caller.sessionId, projectPath: caller.projectPath });
  const bound = collabLiveState(caller.sessionId)?.currentTurnId;
  const turn = (bound ? turns.find((t) => t.turnId === bound) : undefined) ?? turns.at(-1);
  if (!turn) return null;
  return {
    version: 1, projectName: caller.projectName, providerId: "claude", sessionId: caller.sessionId, turnId: turn.turnId,
    n: turn.n, title: caller.title.slice(0, 200), prompt: Array.from(turn.prompt.split("\n")[0] ?? "").slice(0, PROMPT_CHARS).join(""),
    at: turn.startedAt,
  };
}

function nameInProvider(childId: string, providerId: string, title: string, projectPath: string, clientMessageId: string): void {
  void (async () => {
    await waitForTurnBinding(clientMessageId, NAME_WAIT_MS);
    const id = resolveMigratedSession(childId);
    // A Codex session takes its thread's id during its first turn; the title follows it there.
    if (id !== childId) setSessionTitle(id, title);
    if (providerId === "claude") {
      await sdkRenameSession(id, title, { dir: projectPath });
    } else {
      const provider = providerRegistry.get(providerId) as { setThreadName?: (id: string, name: string) => Promise<boolean> } | undefined;
      await provider?.setThreadName?.(id, title);
    }
  })().catch((e) => log.warn(`session=${childId} could not be named in ${providerId}: ${(e as Error).message}`));
}

export const collabEnv: CollabEnv = {
  settings: () => resolveSessionCollabSettings(configService.get("ai").session_collab),
  canonical: (sessionId) => resolveMigratedSession(sessionId),
  live: (sessionId) => collabLiveState(sessionId),
  // The same lookup a new registry entry and every turn's options use, so the check and the run agree.
  storedPermissionMode: getStoredPermissionModeAnyAlias,
  providerDefaultPermissionMode: (providerId) => configService.get("ai").providers?.[providerId]?.permission_mode ?? null,
  storedModel: (sessionId) => firstOf(sessionId, getSessionModel),
  storedProjectPath: (sessionId) => firstOf(sessionId, getSessionProjectPath),
  storedProvider: (sessionId) => firstOf(sessionId, getSessionProvider),
  isDesignSession: (sessionId) => firstOf(sessionId, getSessionDesignSlug) !== null,
  projectNameOf: (projectPath) => configService.get("projects").find((p) => resolve(p.path) === resolve(projectPath))?.name ?? null,
  title: (sessionId) => firstOf(sessionId, getSessionTitle) ?? chatService.getSession(resolveMigratedSession(sessionId))?.title ?? null,
  providerExists: (providerId) => !!providerRegistry.get(providerId),
  links: {
    parentOf, depthOf, childrenOf, recordSpawn,
    linked: (sessionId) => linkedSessions(sessionId).map((l) => l.sessionId),
  },
  pairs: pairCounter,
  approve: (sessionId, input, signal) => collabApprovalBroker.request(sessionId, input, signal),
  waits: collabWaits,
  runningSpawned: (projectName) => [...new Set([
    ...listRunningSessions(projectName).map((s) => resolveMigratedSession(s.sessionId)).filter(isSpawned),
    ...startingChildren(projectName),
  ])],
  reservedSpawnSlots: reservedChildSlots,
  reserveSpawnSlot: reserveChildSlot,
  markStarting: markChildStarting,
  deliver: deliverToSession,
  createSession: async (providerId, input) => (await chatService.createSession(providerId, {
    projectName: input.projectName, projectPath: input.projectPath, title: input.title,
  })).id,
  persistChild: (childId, input) => {
    setSessionMetadata(childId, input.projectName, input.projectPath);
    setSessionTitle(childId, input.title);
    setSessionPermissionMode(childId, input.permissionMode);
    if (input.model) setSessionModel(childId, input.model);
    const session = chatService.getSession(childId);
    if (session) session.title = input.title;
  },
  nameInProvider,
  currentTurnRef: claudeTurnRef,
  announceCreated: announceSessionCreated,
  announceLinks: announceSessionLinkChanged,
  unread: collabUnread,
};
