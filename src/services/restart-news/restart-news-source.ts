import { createLogger } from "../logger.ts";
import { RESTART_NEWS_MAX_RESTARTS, RESTART_NEWS_URGENT_WHEN } from "../../shared/assistant-limits.ts";
import { parseRestartNews, type InterruptedChat, type RestartEntry, type RestartNewsPayload } from "../../shared/restart-news.ts";
import type { AssistantWakeQueue, WakeItem, WakeSource } from "../assistant-wake/assistant-wake-queue.ts";
import type { InterruptedScan } from "./interrupted-chats.ts";

/**
 * The wake queue's restart source: one news item for the main Assistant session holding every
 * restart it has not been told of yet. Each server start adds its restart and the chats it cut
 * off; restarts that come before the news goes out merge into the same item. Kept in a config row
 * (not memory), because the restart that most needs telling about — a crash — would otherwise take
 * the news with it.
 */

export const RESTART_SOURCE_NAME = "restart";
export const RESTART_NEWS_ROW = "assistant_restart_news";
const MAX_ATTEMPTS = 3;
const MAX_CHATS_KEPT = 30;
const log = createLogger("assistant-wake");

interface PendingNews {
  restarts: RestartEntry[];
  chats: InterruptedChat[];
  moreChats: number;
  attempts: number;
}

export interface RestartNewsStore {
  load(): string | null;
  save(json: string): void;
}

const EMPTY: PendingNews = { restarts: [], chats: [], moreChats: 0, attempts: 0 };

function read(store: RestartNewsStore): PendingNews {
  try {
    const raw = JSON.parse(store.load() ?? "null") as { version?: number; attempts?: unknown } & Record<string, unknown> | null;
    if (raw?.version !== 1) return { ...EMPTY };
    // Stored by this module only; anything it no longer accepts is dropped rather than half-read.
    const payload = Array.isArray(raw.restarts) && raw.restarts.length ? parseRestartNews(raw) : null;
    if (!payload) return { ...EMPTY };
    const attempts = typeof raw.attempts === "number" && Number.isInteger(raw.attempts) ? raw.attempts : 0;
    return { restarts: payload.restarts, chats: payload.chats, moreChats: payload.moreChats ?? 0, attempts };
  } catch {
    return { ...EMPTY };
  }
}

function write(store: RestartNewsStore, news: PendingNews): void {
  if (news.restarts.length === 0) {
    store.save(JSON.stringify({ version: 1, restarts: [], chats: [] }));
    return;
  }
  store.save(JSON.stringify({
    version: 1, restarts: news.restarts, chats: news.chats,
    ...(news.moreChats ? { moreChats: news.moreChats } : {}), attempts: news.attempts,
  }));
}

/** Whether news holding these chats starts a turn in quiet hours. */
export function restartNewsUrgent(chats: readonly InterruptedChat[], moreChats = 0): boolean {
  if (RESTART_NEWS_URGENT_WHEN === "always") return true;
  if (RESTART_NEWS_URGENT_WHEN === "never") return false;
  return chats.length + moreChats > 0;
}

/**
 * Adds one server start to the pending news. A start already recorded (the hub started twice in
 * one process) changes nothing. A chat cut off again replaces its older entry.
 */
export function addRestartNews(store: RestartNewsStore, restart: RestartEntry, scan: InterruptedScan): void {
  const news = read(store);
  if (news.restarts.some((r) => r.at === restart.at)) return;
  news.restarts = [...news.restarts, restart].sort((a, b) => a.at - b.at).slice(-RESTART_NEWS_MAX_RESTARTS);
  const byId = new Map(news.chats.map((c) => [c.sessionId, c]));
  for (const c of scan.chats) byId.set(c.sessionId, c);
  const chats = [...byId.values()].sort((a, b) => b.lastAt - a.lastAt);
  news.chats = chats.slice(0, MAX_CHATS_KEPT);
  news.moreChats += scan.more + Math.max(0, chats.length - MAX_CHATS_KEPT);
  news.attempts = 0;
  write(store, news);
}

/**
 * The cut-off chats of `projectName` in the restart news that the Assistant session's running wake
 * turn carries, by session id: what a message from that turn to that project's manager may ask to
 * resume. Empty for any other project, and outside such a turn.
 */
export function cutOffChatsCarried(
  queue: Pick<AssistantWakeQueue, "carriedItems">, assistantSessionId: string, projectName: string,
): string[] {
  const ids = queue.carriedItems(assistantSessionId, RESTART_SOURCE_NAME)
    .flatMap((i) => i.news?.restart?.chats ?? [])
    .filter((c) => c.projectName === projectName)
    .map((c) => c.sessionId);
  return [...new Set(ids)];
}

/** What is pending, for tests and the log. */
export function pendingRestartNews(store: RestartNewsStore): RestartNewsPayload | null {
  const news = read(store);
  return news.restarts.length ? { restarts: news.restarts, chats: news.chats, ...(news.moreChats ? { moreChats: news.moreChats } : {}) } : null;
}

export interface RestartSourceDeps {
  store: RestartNewsStore;
  mainSession(): string | null;
  /** Session ids compare equal across a provider's rename. */
  canonical(sessionId: string): string;
  /** Every project's manager chat, read when the news goes out. */
  managers(): Array<{ projectName: string; sessionId: string }>;
}

export function createRestartNewsSource(deps: RestartSourceDeps): WakeSource {
  /** Clears what `item` carried: restarts and chats up to its time; anything merged in since stays. */
  const clear = (items: WakeItem[]) => {
    const upTo = Math.max(...items.map((i) => i.at));
    const news = read(deps.store);
    const restarts = news.restarts.filter((r) => r.at > upTo);
    write(deps.store, {
      restarts,
      chats: restarts.length ? news.chats.filter((c) => c.restartAt > upTo) : [],
      moreChats: 0,
      attempts: 0,
    });
  };
  return {
    name: RESTART_SOURCE_NAME,
    sessions() {
      if (read(deps.store).restarts.length === 0) return [];
      const main = deps.mainSession();
      return main ? [main] : [];
    },
    pending(sessionId) {
      const main = deps.mainSession();
      if (!main || deps.canonical(sessionId) !== deps.canonical(main)) return [];
      const news = read(deps.store);
      if (news.restarts.length === 0) return [];
      const at = news.restarts.at(-1)!.at;
      const projects = new Set(news.chats.map((c) => c.projectName));
      let managers: Array<{ projectName: string; sessionId: string }> = [];
      try {
        managers = deps.managers().filter((m) => projects.has(m.projectName));
      } catch (e) {
        log.warn(`restart news: the manager chats could not be read: ${(e as Error).message}`);
      }
      const restart: RestartNewsPayload = {
        restarts: news.restarts, chats: news.chats,
        ...(news.moreChats ? { moreChats: news.moreChats } : {}),
        ...(managers.length ? { managers } : {}),
      };
      const key = `restart:${at}`;
      return [{
        key, at, urgent: restartNewsUrgent(news.chats, news.moreChats),
        news: { kind: "restart", key, project: "", sessionId: "", at, restart },
      }];
    },
    delivered: (_id, items) => clear(items),
    ended: (_id, items) => clear(items),
    failed(_id, items) {
      const news = read(deps.store);
      if (news.restarts.length === 0) return false;
      news.attempts += 1;
      if (news.attempts >= MAX_ATTEMPTS) {
        log.warn(`restart news: the Assistant could not be told after ${news.attempts} tries; dropping it`);
        clear(items);
        return false;
      }
      write(deps.store, news);
      return true;
    },
  };
}
