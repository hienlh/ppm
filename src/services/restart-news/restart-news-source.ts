import { createLogger } from "../logger.ts";
import { RESTART_NEWS_MAX_RESTARTS, RESTART_NEWS_URGENT_WHEN } from "../../shared/assistant-limits.ts";
import {
  parseRestartNews, type BackgroundTask, type BackgroundWorkChat, type InterruptedChat, type RestartEntry, type RestartNewsPayload,
} from "../../shared/restart-news.ts";
import type { AssistantWakeQueue, WakeItem, WakeSource } from "../assistant-wake/assistant-wake-queue.ts";
import type { InterruptedScan } from "./interrupted-chats.ts";
import { refreshTaskStates, type BackgroundScan } from "./background-work-chats.ts";
import type { TaskOutputProbe } from "./task-output-file.ts";

/**
 * The wake queue's restart source: one news item for the main Assistant session holding every
 * restart it has not been told of yet. Each server start adds its restart, the chats it cut off,
 * and the chats between turns whose background work it stopped; restarts that come before the news goes out merge into the same item. Kept in a config row
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
  background: BackgroundWorkChat[];
  moreBackground: number;
  attempts: number;
}

/** Either list's chat: what the re-check and the expiry read. */
type ListedChat = Pick<InterruptedChat, "sessionId" | "restartAt">;

export interface RestartNewsStore {
  load(): string | null;
  save(json: string): void;
}

const EMPTY: PendingNews = { restarts: [], chats: [], moreChats: 0, background: [], moreBackground: 0, attempts: 0 };

function read(store: RestartNewsStore): PendingNews {
  try {
    const raw = JSON.parse(store.load() ?? "null") as { version?: number; attempts?: unknown } & Record<string, unknown> | null;
    if (raw?.version !== 1) return { ...EMPTY };
    // Stored by this module only; anything it no longer accepts is dropped rather than half-read.
    const payload = Array.isArray(raw.restarts) && raw.restarts.length ? parseRestartNews(raw) : null;
    if (!payload) return { ...EMPTY };
    const attempts = typeof raw.attempts === "number" && Number.isInteger(raw.attempts) ? raw.attempts : 0;
    return {
      restarts: payload.restarts, chats: payload.chats, moreChats: payload.moreChats ?? 0,
      background: payload.backgroundChats ?? [], moreBackground: payload.moreBackgroundChats ?? 0, attempts,
    };
  } catch {
    return { ...EMPTY };
  }
}

function write(store: RestartNewsStore, news: PendingNews): void {
  if (news.restarts.length === 0) {
    store.save(JSON.stringify({ version: 1, restarts: [], chats: [] }));
    return;
  }
  store.save(JSON.stringify({ version: 1, ...payloadOf(news), attempts: news.attempts }));
}

function payloadOf(news: PendingNews): RestartNewsPayload {
  return {
    restarts: news.restarts, chats: news.chats,
    ...(news.moreChats ? { moreChats: news.moreChats } : {}),
    ...(news.background.length ? { backgroundChats: news.background } : {}),
    ...(news.moreBackground ? { moreBackgroundChats: news.moreBackground } : {}),
  };
}

/**
 * Whether news holding these chats starts a turn in quiet hours: any chat to get going again, cut
 * off mid-turn or with its background work stopped, makes it urgent.
 */
export function restartNewsUrgent(chats: readonly InterruptedChat[], moreChats = 0, backgroundChats = 0): boolean {
  if (RESTART_NEWS_URGENT_WHEN === "always") return true;
  if (RESTART_NEWS_URGENT_WHEN === "never") return false;
  return chats.length + moreChats + backgroundChats > 0;
}

/** One entry per session id, the newer one winning, newest first. */
function mergeChats<T extends { sessionId: string; lastAt: number }>(older: readonly T[], newer: readonly T[]): T[] {
  const byId = new Map(older.map((c) => [c.sessionId, c]));
  for (const c of newer) byId.set(c.sessionId, c);
  return [...byId.values()].sort((a, b) => b.lastAt - a.lastAt);
}

/** Background tasks a chat shows at most; the rest are counted (the payload accepts twice as many). */
const MAX_TASKS_KEPT = 5;

/**
 * Like {@link mergeChats}, but a chat whose background work two restarts stopped keeps the tasks of
 * both, each once (the newer restart's word on a task wins), so none of the stopped work goes untold.
 */
function mergeBackgroundChats(older: readonly BackgroundWorkChat[], newer: readonly BackgroundWorkChat[]): BackgroundWorkChat[] {
  const olderById = new Map(older.map((c) => [c.sessionId, c]));
  const merged = newer.map((c) => {
    const before = olderById.get(c.sessionId);
    if (!before) return c;
    const byTask = new Map(before.tasks.map((t) => [t.taskId, t]));
    for (const t of c.tasks) byTask.set(t.taskId, t);
    const tasks = [...byTask.values()].sort((a, b) => b.startedAt - a.startedAt);
    const more = (before.moreTasks ?? 0) + (c.moreTasks ?? 0) + Math.max(0, tasks.length - MAX_TASKS_KEPT);
    const { moreTasks: _drop, ...rest } = c;
    return { ...rest, tasks: tasks.slice(0, MAX_TASKS_KEPT), ...(more > 0 ? { moreTasks: more } : {}) };
  });
  return mergeChats(older, merged);
}

/**
 * Adds one server start to the pending news. A start already recorded (the hub started twice in
 * one process) changes nothing. A chat cut off again replaces its older entry; a chat whose
 * background work was stopped again keeps the stopped tasks of both.
 */
export function addRestartNews(store: RestartNewsStore, restart: RestartEntry, scan: InterruptedScan, background: BackgroundScan = { chats: [], more: 0 }): void {
  const news = read(store);
  if (news.restarts.some((r) => r.at === restart.at)) return;
  // A self-replace that failed after its new version briefly ran: that run's "upgraded" line is
  // no longer true, and telling both would read as an upgrade then a downgrade. The failed entry
  // says the whole story; chats either run cut off stay listed.
  const superseded = (r: RestartEntry) => !!restart.upgradeFailed && r.kind === "upgrade" && !r.upgradeFailed
    && !!restart.fromVersion && r.toVersion === restart.fromVersion && r.at < restart.at;
  news.restarts = [...news.restarts.filter((r) => !superseded(r)), restart].sort((a, b) => a.at - b.at).slice(-RESTART_NEWS_MAX_RESTARTS);
  // A chat in both lists (found by two restarts, say cut off at one and between turns at the next)
  // is told once, as the later restart found it; one restart never puts a chat in both.
  const cutAll = mergeChats(news.chats, scan.chats);
  const bgAll = mergeBackgroundChats(news.background, background.chats);
  const cutAt = new Map(cutAll.map((c) => [c.sessionId, c.restartAt]));
  const bgAt = new Map(bgAll.map((c) => [c.sessionId, c.restartAt]));
  const cut = cutAll.filter((c) => !((bgAt.get(c.sessionId) ?? -Infinity) > c.restartAt));
  const bg = bgAll.filter((c) => !((cutAt.get(c.sessionId) ?? -Infinity) >= c.restartAt));
  news.chats = cut.slice(0, MAX_CHATS_KEPT);
  news.moreChats += scan.more + Math.max(0, cut.length - MAX_CHATS_KEPT);
  news.background = bg.slice(0, MAX_CHATS_KEPT);
  news.moreBackground += background.more + Math.max(0, bg.length - MAX_CHATS_KEPT);
  news.attempts = 0;
  write(store, news);
}

/**
 * The chats of `projectName` in the restart news that the Assistant session's running wake turn
 * carries, by session id — those cut off mid-turn, then those whose background work stopped: what a
 * message from that turn to that project's manager may ask to resume or run again. Empty for any
 * other project, and outside such a turn.
 */
export function restartChatsCarried(
  queue: Pick<AssistantWakeQueue, "carriedItems">, assistantSessionId: string, projectName: string,
): string[] {
  const items = queue.carriedItems(assistantSessionId, RESTART_SOURCE_NAME);
  const ids = [
    ...items.flatMap((i) => i.news?.restart?.chats ?? []),
    ...items.flatMap((i) => i.news?.restart?.backgroundChats ?? []),
  ].filter((c) => c.projectName === projectName).map((c) => c.sessionId);
  return [...new Set(ids)];
}

/**
 * The text PPM wrote into the restart news that the Assistant session's running wake turn carries,
 * for chats of `projectName`: titles, cut-off prompts, and background task descriptions and
 * commands. A message from that turn to that project's manager quoting it is PPM quoting itself.
 * Empty for any other project, and outside such a turn.
 */
export function restartTextCarried(
  queue: Pick<AssistantWakeQueue, "carriedItems">, assistantSessionId: string, projectName: string,
): string[] {
  const out: string[] = [];
  for (const item of queue.carriedItems(assistantSessionId, RESTART_SOURCE_NAME)) {
    const restart = item.news?.restart;
    if (!restart) continue;
    const taskText = (tasks: readonly BackgroundTask[]) => tasks.flatMap((t) => [t.description, t.command].filter((x): x is string => !!x));
    for (const c of restart.chats) {
      if (c.projectName === projectName) out.push(c.title, ...(c.prompt ? [c.prompt] : []), ...taskText(c.killedTasks ?? []));
    }
    for (const c of restart.backgroundChats ?? []) {
      if (c.projectName === projectName) out.push(c.title, ...taskText(c.tasks));
    }
  }
  return [...new Set(out)];
}

/** What is pending, for tests and the log. */
export function pendingRestartNews(store: RestartNewsStore): RestartNewsPayload | null {
  const news = read(store);
  return news.restarts.length ? payloadOf(news) : null;
}

export interface RestartSourceDeps {
  store: RestartNewsStore;
  mainSession(): string | null;
  /** Session ids compare equal across a provider's rename. */
  canonical(sessionId: string): string;
  /** Every project's manager chat, read when the news goes out. */
  managers(): Array<{ projectName: string; sessionId: string }>;
  /**
   * Whether a listed chat still waits to be resumed when the news goes out: false once it has run
   * again since the restart that found it, or was deleted. News can wait hours (a busy Assistant,
   * the hourly cap, no main session yet), and telling a manager to resume a chat the user already
   * resumed would run the same work twice. Absent: every chat is taken as still cut off.
   */
  stillCutOff?(chat: ListedChat): boolean;
  /**
   * A probe for whether a background task's output was written after `since`, built once per
   * re-check when the news goes out; absent: task states stay as the scan found them.
   */
  taskOutputProbe?(): TaskOutputProbe;
  now?(): number;
  /** Settings → PPM Assistant → restart news. Switched off, news already waiting is dropped too. */
  enabled?(): boolean;
}

/** Pending news older than this is dropped rather than told: its chats are a day stale. */
export const RESTART_NEWS_MAX_AGE_MS = 24 * 60 * 60_000;

export function createRestartNewsSource(deps: RestartSourceDeps): WakeSource {
  const now = () => (deps.now ? deps.now() : Date.now());
  const waiting = <T extends ListedChat>(list: readonly T[]): T[] => (deps.stillCutOff
    ? list.filter((c) => {
      try { return deps.stillCutOff!(c); } catch { return true; }
    })
    : [...list]);
  /**
   * The listed chats that still wait, with background tasks whose output has been written since the
   * restart marked alive; the pending row is rewritten when anything changed.
   */
  const recheck = (news: PendingNews): PendingNews => {
    if (news.chats.length + news.background.length + news.moreChats + news.moreBackground === 0) return news;
    const still = waiting(news.chats);
    const stillBackground = waiting(news.background);
    let probe: TaskOutputProbe | null = null;
    if (deps.taskOutputProbe && stillBackground.some((c) => c.tasks.some((t) => t.state === "unknown"))) {
      try { probe = deps.taskOutputProbe(); } catch { /* states stay as found */ }
    }
    const background = probe ? stillBackground.map((c) => refreshTaskStates(c, probe!)) : stillBackground;
    const dropped = news.chats.length - still.length + news.background.length - background.length;
    const orphaned = (!still.length && news.moreChats > 0) || (!background.length && news.moreBackground > 0);
    if (dropped === 0 && !orphaned && background.every((c, i) => c === news.background[i])) return news;
    if (dropped) log.info(`restart news: ${dropped} listed chat(s) ran again or were deleted since the restart; not telling of them`);
    // An unlisted count cannot be re-checked, and goes with the last listed chat of its list. A list
    // holds the most recent such chats; once every one of them has run again the user is back at work,
    // and a bare count would keep the news urgent (through quiet hours) and tell the Assistant "N more
    // chats were cut off" beside "no chat was cut off" — while no manager message could name them.
    const moreChats = still.length ? news.moreChats : 0;
    const moreBackground = background.length ? news.moreBackground : 0;
    const lost = news.moreChats + news.moreBackground - moreChats - moreBackground;
    if (lost) log.info(`restart news: no listed chat of a list still waits; dropping its ${lost} unlisted one(s) too`);
    const next = { ...news, chats: still, moreChats, background, moreBackground };
    write(deps.store, next);
    return next;
  };
  /** Off unless the switch says on; a switch that cannot be read leaves the news as it is. */
  const switchedOff = (): boolean => {
    try { return deps.enabled ? !deps.enabled() : false; } catch { return false; }
  };
  /**
   * Drops restarts (and the chats they found) older than {@link RESTART_NEWS_MAX_AGE_MS}, and all of
   * it once the switch is off: whoever turned it off does not want the Assistant told any more.
   */
  const expire = (): void => {
    const news = read(deps.store);
    if (news.restarts.length === 0) return;
    if (switchedOff()) {
      log.info(`restart news is switched off: dropping the ${news.restarts.length} restart(s) still waiting to be told`);
      write(deps.store, { ...EMPTY });
      return;
    }
    const cutoff = now() - RESTART_NEWS_MAX_AGE_MS;
    const restarts = news.restarts.filter((r) => r.at >= cutoff);
    if (restarts.length === news.restarts.length) return;
    log.info(`restart news: dropping ${news.restarts.length - restarts.length} restart(s) older than 24 h that the Assistant was never told of`);
    write(deps.store, restarts.length
      ? {
        ...news, restarts,
        chats: news.chats.filter((c) => c.restartAt >= cutoff),
        background: news.background.filter((c) => c.restartAt >= cutoff),
      }
      : { ...EMPTY });
  };
  /** Clears what `item` carried: restarts and chats up to its time; anything merged in since stays. */
  const clear = (items: WakeItem[]) => {
    const upTo = Math.max(...items.map((i) => i.at));
    const news = read(deps.store);
    const restarts = news.restarts.filter((r) => r.at > upTo);
    // The unlisted count the turn told of is spent; what restarts merged in since added stays.
    const told = items.reduce((n, i) => n + (i.news?.restart?.moreChats ?? 0), 0);
    const toldBackground = items.reduce((n, i) => n + (i.news?.restart?.moreBackgroundChats ?? 0), 0);
    write(deps.store, {
      restarts,
      chats: restarts.length ? news.chats.filter((c) => c.restartAt > upTo) : [],
      moreChats: restarts.length ? Math.max(0, news.moreChats - told) : 0,
      background: restarts.length ? news.background.filter((c) => c.restartAt > upTo) : [],
      moreBackground: restarts.length ? Math.max(0, news.moreBackground - toldBackground) : 0,
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
      // A pump the queue starts on its own skips the tick's expiry: day-old news must not go out then either.
      expire();
      const stored = read(deps.store);
      if (stored.restarts.length === 0) return [];
      const news = recheck(stored);
      const at = news.restarts.at(-1)!.at;
      const projects = new Set([...news.chats, ...news.background].map((c) => c.projectName));
      let managers: Array<{ projectName: string; sessionId: string }> = [];
      try {
        managers = deps.managers().filter((m) => projects.has(m.projectName));
      } catch (e) {
        log.warn(`restart news: the manager chats could not be read: ${(e as Error).message}`);
      }
      const restart: RestartNewsPayload = { ...payloadOf(news), ...(managers.length ? { managers } : {}) };
      const key = `restart:${at}`;
      // Never held by the hourly cap: every restart not yet told is merged into this one item, so a
      // run of restarts still makes one turn, and waiting would leave cut-off chats stopped longer.
      return [{
        key, at, urgent: restartNewsUrgent(news.chats, news.moreChats, news.background.length + news.moreBackground), capExempt: true,
        news: { kind: "restart", key, project: "", sessionId: "", at, restart },
      }];
    },
    expire,
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
