/**
 * The main Assistant session: the one Telegram follows. Exactly one at a time, a Claude Assistant
 * session (a Codex one stays usable for one-off questions), stored in the `assistant` config row
 * and always read through `resolveMigratedSession`.
 *
 * PPM picks it by itself twice: when the first Assistant session is created and none is main, and
 * at the first start after an upgrade, where it prefers the session the most recently used
 * Telegram chat talks to, so Telegram keeps talking to the same conversation. Deleting it clears
 * the setting.
 */
import { getSessionProvider, resolveMigratedSession } from "../db.service.ts";
import { isAssistantSession } from "./assistant-session.ts";
import { getAssistantSettings, writeMainSessionSetting } from "./assistant-settings.service.ts";
import { MAIN_SESSION_CHANGED_EVENT, MANAGER_PROVIDER_ID, type MainSessionRef } from "../../shared/assistant-managers.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("assistant");

export class MainSessionError extends Error {}

/** Loaded on use: the global socket loads after the services that create and delete sessions. */
function announce(ref: MainSessionRef | null): void {
  const payload = ref ?? { providerId: null, sessionId: null };
  void import("../../server/ws/global.ts")
    .then(({ broadcastGlobalEvent }) => broadcastGlobalEvent({ type: MAIN_SESSION_CHANGED_EVENT, ...payload }))
    .catch((e) => log.warn(`Could not announce the main session: ${(e as Error).message}`));
}

const providerOf = (sessionId: string): string | null =>
  getSessionProvider(resolveMigratedSession(sessionId)) ?? getSessionProvider(sessionId);

/** Why the session cannot be the main one, or null. */
export function mainSessionRefusal(sessionId: string): string | null {
  if (!isAssistantSession(sessionId)) return "Not a PPM Assistant session";
  if (providerOf(sessionId) !== MANAGER_PROVIDER_ID) return "The main session runs on Claude for now";
  return null;
}

/** The main session by its current id, or null when none is set or it no longer exists. */
export function getMainSession(): MainSessionRef | null {
  const stored = getAssistantSettings().main_session;
  if (!stored) return null;
  const sessionId = resolveMigratedSession(stored.session_id);
  // A deleted session loses its metadata, and with it the Assistant mark.
  if (!isAssistantSession(sessionId)) return null;
  return { providerId: MANAGER_PROVIDER_ID, sessionId };
}

/** Makes the session the main one; the one it replaces, or null. Throws when it may not be. */
export function setMainSession(asked: string): { previous: string | null; current: string } {
  const sessionId = resolveMigratedSession(asked);
  const refusal = mainSessionRefusal(sessionId);
  if (refusal) throw new MainSessionError(refusal);
  const previous = getMainSession()?.sessionId ?? null;
  writeMainSessionSetting({ provider_id: MANAGER_PROVIDER_ID, session_id: sessionId });
  if (previous !== sessionId) {
    log.info(`Main Assistant session is now ${sessionId}${previous ? ` (was ${previous})` : ""}`);
    announce({ providerId: MANAGER_PROVIDER_ID, sessionId });
  }
  return { previous, current: sessionId };
}

/** A new Assistant session becomes the main one when there is none and it can be. */
export function adoptAsMainIfNone(sessionId: string, providerId: string): boolean {
  if (providerId !== MANAGER_PROVIDER_ID || getMainSession()) return false;
  try {
    setMainSession(sessionId);
    return true;
  } catch (e) {
    log.debug(`Session ${sessionId} not made main: ${(e as Error).message}`);
    return false;
  }
}

/** A deleted main session clears the setting. */
export function clearMainSessionIf(sessionId: string): void {
  const stored = getAssistantSettings().main_session;
  if (!stored) return;
  const current = resolveMigratedSession(stored.session_id);
  if (stored.session_id !== sessionId && current !== sessionId && current !== resolveMigratedSession(sessionId)) return;
  writeMainSessionSetting(null);
  log.info(`Main Assistant session ${current} was deleted; none is main now`);
  announce(null);
}

export interface UpgradePickSources {
  /** Telegram bindings, most recently updated first. */
  boundSessionIds(): string[];
  /** Assistant sessions on Claude, most recently active first. */
  recentAssistantSessionIds(): Promise<string[]>;
}

/**
 * At startup while no main was ever set (an install from before main sessions existed): the
 * session the most recently used Telegram chat talks to, else the most recently active Assistant
 * session; only a Claude one either way. Null when none fits. A main the user cleared, by deleting
 * it, stays cleared: Settings offers to start one, and the next Claude session created takes it.
 */
export async function pickMainSessionOnStartup(sources: UpgradePickSources): Promise<string | null> {
  const neverSet = () => getAssistantSettings().main_session === undefined;
  if (!neverSet()) return null;
  const candidates = [...sources.boundSessionIds(), ...await sources.recentAssistantSessionIds()];
  // A session created while the list was being read may have taken the role meanwhile.
  if (!neverSet()) return null;
  for (const id of candidates) {
    if (mainSessionRefusal(id)) continue;
    setMainSession(id);
    return resolveMigratedSession(id);
  }
  return null;
}
