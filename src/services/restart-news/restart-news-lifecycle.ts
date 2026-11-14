import { resolve } from "node:path";
import { createLogger } from "../logger.ts";
import { configService } from "../config.service.ts";
import {
  getConfigValue, getSessionDesignSlug, getSessionProjectPath, getSessionProvider, getSessionTitle,
  resolveMigratedSession, sessionIdAliases, setConfigValue,
} from "../db.service.ts";
import { getTraceDb } from "../session-trace/session-trace-db.ts";
import { assistantWakeQueue } from "../assistant-wake/assistant-wake-queue.ts";
import { getAssistantSettings } from "../assistant/assistant-settings.service.ts";
import { getMainSession } from "../assistant/assistant-main-session.ts";
import { isAssistantSession } from "../assistant/assistant-session.ts";
import { managerChats } from "../assistant-managers/manager-chats.service.ts";
import { listOpenCardRows } from "../assistant-cards/assistant-cards-db.ts";
import { parentOf } from "../session-collab/session-links.service.ts";
import { resolveTraceId } from "../session-trace/session-trace-store.ts";
import type { InterruptedChat } from "../../shared/restart-news.ts";
import { findInterruptedChats, tracesWrittenSince, type InterruptedChatDeps, type InterruptedScan } from "./interrupted-chats.ts";
import type { ServerStart } from "./server-run-log.ts";
import { currentServerStart } from "./restart-news-run.ts";
import { addRestartNews, createRestartNewsSource, RESTART_NEWS_ROW, restartNewsUrgent, type RestartNewsStore } from "./restart-news-source.ts";

/**
 * Restart news in the running server: the Assistant hub's startup turns this server start
 * (recorded at boot by `restart-news-run.ts`) into news for the main Assistant session — why PPM
 * restarted and which chats it cut off — through the one wake queue. The run log is written
 * whatever Settings say; only the news obeys Settings → PPM Assistant → `restart_news`.
 */

const log = createLogger("restart-news");
const newsStore: RestartNewsStore = { load: () => getConfigValue(RESTART_NEWS_ROW), save: (json) => setConfigValue(RESTART_NEWS_ROW, json) };

let queuedFor: number | null = null;
let removeSource: (() => void) | null = null;

const firstOf = <T>(sessionId: string, read: (id: string) => T | null): T | null => {
  for (const id of sessionIdAliases(sessionId)) {
    const value = read(id);
    if (value !== null && value !== undefined) return value;
  }
  return null;
};

/** The running server's answers for the scan; open cards are counted once, up front. */
function liveDeps(): InterruptedChatDeps {
  const openCards = new Map<string, number>();
  try {
    for (const row of listOpenCardRows()) {
      if (!row.sessionId) continue;
      const id = resolveMigratedSession(row.sessionId);
      openCards.set(id, (openCards.get(id) ?? 0) + 1);
    }
  } catch { /* no cards counted */ }
  return {
    traceDb: getTraceDb(),
    sessionOf: (traceId) => resolveMigratedSession(traceId),
    projectPathOf: (id) => firstOf(id, getSessionProjectPath),
    projectNameOf: (path) => configService.get("projects").find((p) => resolve(p.path) === resolve(path))?.name ?? null,
    providerOf: (id) => firstOf(id, getSessionProvider),
    titleOf: (id) => firstOf(id, getSessionTitle),
    isAssistant: (id, path) => isAssistantSession(id, path),
    isDesign: (id) => firstOf(id, getSessionDesignSlug) !== null,
    managerOf: (path) => {
      const row = managerChats.managerFor(path);
      return row ? resolveMigratedSession(row.sessionId) : null;
    },
    parentOf: (id) => {
      const parent = parentOf(id);
      return parent ? resolveMigratedSession(parent) : null;
    },
    openCardsOf: (id) => openCards.get(id) ?? 0,
  };
}

export interface RestartNewsStartDeps {
  /** This process's start; the one recorded at boot when absent. */
  start?: ServerStart | null;
  scan?: (start: ServerStart) => InterruptedScan;
  enabled?: () => boolean;
  store?: RestartNewsStore;
  mainSession?: () => string | null;
  stillCutOff?: (chat: InterruptedChat) => boolean;
}

/**
 * Whether a chat the news lists is still waiting when the news goes out: this database still knows
 * it (it was not deleted), and none of the traces it went by has a row since the restart that found it.
 */
function stillCutOffLive(chat: InterruptedChat): boolean {
  if (firstOf(chat.sessionId, getSessionProjectPath) === null) return false;
  const traceIds = [...new Set(sessionIdAliases(chat.sessionId).map(resolveTraceId))];
  return !tracesWrittenSince(getTraceDb(), traceIds, chat.restartAt);
}

/**
 * Registers the restart source with the wake queue and adds this start's news to it. Called by
 * the Assistant hub before the cards start the queue, so news a crash left pending goes out on the
 * queue's first tick. Calling it again in one process adds nothing.
 */
export function startRestartNews(deps: RestartNewsStartDeps = {}): void {
  const store = deps.store ?? newsStore;
  const start = deps.start === undefined ? currentServerStart() : deps.start;
  if (start && queuedFor !== start.run.startedAt) {
    queuedFor = start.run.startedAt;
    queueStart(start, store, deps);
  }
  if (!removeSource) {
    removeSource = assistantWakeQueue.addSource(createRestartNewsSource({
      store,
      mainSession: deps.mainSession ?? (() => {
        try { return getMainSession()?.sessionId ?? null; } catch { return null; }
      }),
      canonical: resolveMigratedSession,
      managers: () => managerChats.list().map((r) => ({ projectName: r.projectName, sessionId: resolveMigratedSession(r.sessionId) })),
      stillCutOff: deps.stillCutOff ?? stillCutOffLive,
      enabled: deps.enabled ?? (() => getAssistantSettings().restart_news),
    }));
  }
}

function queueStart(start: ServerStart, store: RestartNewsStore, deps: RestartNewsStartDeps): void {
  // The first run this database ever recorded (a new install, or one from before the run log):
  // there is no previous run to report on, so nothing restarted as far as anyone can tell.
  if (!start.previous) {
    log.info("first recorded server run: no restart news");
    return;
  }
  let enabled = true;
  try { enabled = (deps.enabled ?? (() => getAssistantSettings().restart_news))(); } catch { /* on unless switched off */ }
  if (!enabled) {
    log.info("restart news is switched off: the Assistant is not told of this restart");
    return;
  }
  let scan: InterruptedScan = { chats: [], more: 0 };
  try {
    // The previous run's start bounds the scan: an older unfinished turn is not this restart's doing.
    const read = deps.scan ?? ((s: ServerStart) => findInterruptedChats(liveDeps(), { since: s.previous?.startedAt ?? 0, restartAt: s.run.startedAt }));
    scan = read(start);
  } catch (e) {
    log.warn(`could not read which chats the restart cut off: ${(e as Error).message}`);
  }
  try {
    addRestartNews(store, start.restart, scan);
    const n = scan.chats.length + scan.more;
    log.info(`restart news queued: ${start.restart.kind}, ${n} chat(s) cut off${restartNewsUrgent(scan.chats, scan.more) ? " (urgent)" : ""}`);
  } catch (e) {
    log.warn(`could not queue the restart news: ${(e as Error).message}`);
  }
}

export function stopRestartNews(): void {
  removeSource?.();
  removeSource = null;
}

/** For tests: forget this process's registration and what it queued. */
export function _resetRestartNews(): void {
  stopRestartNews();
  queuedFor = null;
}
