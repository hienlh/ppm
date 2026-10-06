/**
 * New log records, pushed to the Logs views that are open — and only while one is. A view
 * subscribes over `/ws/global`; the first subscriber starts a one-second poll of `ppm.log`,
 * `cloudflared.log` and the browser rows, the last one to leave stops it. Polling rather than
 * `fs.watch`: the log is appended to many times a second, and one read a second is both cheaper
 * and enough for a person watching.
 */
import { createLogger } from "../logger.ts";
import { getSessionTitles } from "../db.service.ts";
import { lastTraceRowid } from "../session-trace/session-trace-store.ts";
import type { LogsLinesEvent } from "../../shared/logs-api.ts";
import { readNewEntries, type TailCursor } from "./log-store.ts";

const log = createLogger("logs");
const POLL_MS = 1000;
/** A burst past this is cut to its newest lines; the window can page back for the rest. */
const MAX_PUSH = 2000;

interface Subscriber {
  send(data: string): number | void;
}

/**
 * Subscriber → whether it may still read the logs. `/ws/global` checks its token at upgrade
 * only, so the check runs again on subscribe and before every push — a socket whose token was
 * rotated away stops receiving at the next tick.
 */
const subscribers = new Map<Subscriber, () => boolean>();
let timer: ReturnType<typeof setInterval> | null = null;
let cursor: TailCursor | null = null;
let ticking = false;

async function tick(): Promise<void> {
  if (ticking || subscribers.size === 0) return;
  ticking = true;
  try {
    const next = await readNewEntries(cursor, lastTraceRowid);
    const fresh = cursor !== null;
    cursor = next.cursor;
    if (!fresh || next.entries.length === 0) return;
    const entries = next.entries.slice(-MAX_PUSH);
    const sids = [...new Set(entries.map((e) => e.sid).filter((s): s is string => !!s))];
    let titles: Record<string, string> = {};
    try { titles = sids.length ? getSessionTitles(sids) : {}; } catch { /* ids stand in for titles */ }
    const event: LogsLinesEvent = { type: "logs:lines", entries, titles };
    const json = JSON.stringify(event);
    for (const [s, allowed] of subscribers) {
      if (!allowed()) {
        unsubscribeLogs(s);
        continue;
      }
      try { s.send(json); } catch { /* going away; unsubscribe will follow */ }
    }
  } catch (e) {
    log.warn(`live tail read failed: ${(e as Error).message}`);
  } finally {
    ticking = false;
  }
}

export function subscribeLogs(ws: Subscriber, allowed: () => boolean): void {
  if (subscribers.has(ws) || !allowed()) return;
  subscribers.set(ws, allowed);
  if (timer) return;
  cursor = null;
  void tick(); // takes the current ends, so the first push is only what comes after
  timer = setInterval(() => void tick(), POLL_MS);
  log.debug(`live tail started (${subscribers.size} watching)`);
}

export function unsubscribeLogs(ws: Subscriber): void {
  if (!subscribers.delete(ws)) return;
  if (subscribers.size > 0 || !timer) return;
  clearInterval(timer);
  timer = null;
  cursor = null;
  log.debug("live tail stopped");
}

export function logSubscriberCount(): number {
  return subscribers.size;
}
