import type { AssistantWatch } from "../assistant-hub/assistant-hub-db.ts";
import type { WatchEventKind, WatchEventNotice } from "../../types/chat.ts";

/**
 * What a watch keeps besides its table columns, serialised into `event_json`: which news the
 * Assistant asked for, the news itself once it happened, and how many watch turns failed to
 * report it. Owned by the watch service; nothing else reads it.
 */

/** Watches one Assistant session may have running at once. */
export const MAX_ACTIVE_WATCHES = 20;

/**
 * Which ends of a watched run wake the Assistant. Nothing here decides whether the chat's cards
 * reach the user: a watch always relays them, because a card left unseen blocks the run, and
 * then the end the Assistant is waiting for can never come.
 */
export const NOTIFY_KINDS = ["done", "stopped"] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];

/**
 * A kind `notifyOn` used to have, when cards were relayed only on request. Still accepted, and
 * ignored, so a model or a stored watch that names it is not refused for it.
 */
const LEGACY_DECISION = "decision";

export interface WatchState {
  notifyOn: NotifyKind[];
  /** Set once the watched chat's run ended (or the watch expired). */
  event?: WatchEventNotice;
  /** Watch turns that ran and did not end with an answer. */
  attempts?: number;
}

/**
 * `notifyOn` as an agent sent it: a non-empty list of known kinds, each once; all of them when
 * absent. A list naming only the legacy `decision` would wake the Assistant for nothing, which is
 * never what was meant, so it is refused with the reason. A stored watch is read with
 * `allowEmpty`: such a row asked to hear about no end, and that is what it still gets.
 */
export function parseNotifyOn(raw: unknown, opts: { allowEmpty?: boolean } = {}): { ok: true; value: NotifyKind[] } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: [...NOTIFY_KINDS] };
  const known = (k: unknown) => k === LEGACY_DECISION || NOTIFY_KINDS.includes(k as NotifyKind);
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every(known)) {
    return { ok: false, error: `\`notifyOn\` must be a non-empty list of ${NOTIFY_KINDS.map((k) => `"${k}"`).join(", ")}.` };
  }
  const value = NOTIFY_KINDS.filter((k) => raw.includes(k));
  if (value.length === 0 && !opts.allowEmpty) {
    return { ok: false, error: `\`notifyOn\` must name "done", "stopped" or both. The watched chat's approval cards go to the user whatever it says.` };
  }
  return { ok: true, value };
}

/** The state of a stored watch; a row with none, or one that does not parse, asks for everything. */
export function readWatchState(watch: Pick<AssistantWatch, "eventJson">): WatchState {
  if (!watch.eventJson) return { notifyOn: [...NOTIFY_KINDS] };
  try {
    const parsed = JSON.parse(watch.eventJson) as Partial<WatchState>;
    const notifyOn = parseNotifyOn(parsed.notifyOn, { allowEmpty: true });
    return {
      notifyOn: notifyOn.ok ? notifyOn.value : [...NOTIFY_KINDS],
      ...(parsed.event && typeof parsed.event === "object" ? { event: parsed.event as WatchEventNotice } : {}),
      ...(typeof parsed.attempts === "number" ? { attempts: parsed.attempts } : {}),
    };
  } catch {
    return { notifyOn: [...NOTIFY_KINDS] };
  }
}

export const writeWatchState = (state: WatchState): string => JSON.stringify(state);

/**
 * Whether news of this kind wakes the Assistant. An expiry always does — it is the one report a
 * watch owes whatever was asked — and an interruption counts as a stop.
 */
export function wakesFor(kind: WatchEventKind, notifyOn: readonly NotifyKind[]): boolean {
  if (kind === "expired") return true;
  return notifyOn.includes(kind === "interrupted" ? "stopped" : kind);
}

/** A watch fired, expired or not, whose news has not reached the user yet. */
export const awaitsDelivery = (w: AssistantWatch): boolean =>
  (w.status === "fired" || w.status === "expired") && w.deliveredAt === null;

/** A watch as the Assistant's tools show it. */
export function watchView(w: AssistantWatch, title: string) {
  const state = readWatchState(w);
  return {
    watchId: w.id,
    project: w.targetProject,
    sessionId: w.targetSessionId,
    providerId: w.targetProvider,
    title,
    status: w.status,
    notifyOn: state.notifyOn,
    createdAt: new Date(w.createdAt).toISOString(),
    expiresAt: new Date(w.expiresAt).toISOString(),
    ...(state.event ? { event: state.event.kind, eventAt: new Date(state.event.at).toISOString() } : {}),
    ...(w.status === "fired" || w.status === "expired" ? { reported: w.deliveredAt !== null } : {}),
  };
}
export type WatchView = ReturnType<typeof watchView>;
