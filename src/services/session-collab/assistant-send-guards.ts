/**
 * What holds back PPM Assistant's messages to manager chats in turns nobody started: an hourly and
 * a daily budget per Assistant session, the pair limit between the Assistant and one manager,
 * quiet hours, and a pause that only the user's next message lifts. Plus two checks for every
 * message to a manager, attended or not: the same text twice within an hour is dropped, and a
 * text that looks like it holds a secret is never sent without a card.
 *
 * The budget counts survive a restart (the `assistant_budget_state` config row, which no settings
 * save touches); the pair counts and the duplicate memory live in memory. Every check that counts
 * reserves in the same synchronous step, so sends arriving together cannot all pass it; a send
 * that then fails to deliver gives its reservation back.
 */
import { createHash } from "node:crypto";
import {
  DUPLICATE_SEND_WINDOW_MS, UNATTENDED_SENDS_PER_DAY, UNATTENDED_SENDS_PER_HOUR,
} from "../../shared/assistant-limits.ts";
import { redactSecretsForTelegram } from "../telegram/telegram-html-format.ts";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

export type BudgetHit = "hour" | "day" | "pair";

export interface AssistantSendGuardsEnv {
  now(): number;
  /** Whether quiet hours are on right now. */
  quiet(): boolean;
  /** The stored budget state, or null. */
  load(): string | null;
  save(json: string): void;
  /** The Assistant paused messaging (`paused`) or was let go again (`resumed`). */
  announce?(event: { type: "paused"; sessionId: string; reason: BudgetHit } | { type: "resumed"; sessionId: string }): void;
}

export type Reservation =
  | { ok: true; release(): void }
  | { ok: false; reason: "quiet" | "paused" | BudgetHit; message: string; pausedNow: boolean };

export const QUIET_HOURS_REFUSAL = "Quiet hours: nothing PPM started on its own may reach a manager chat now, so nothing was sent. "
  + "Report to the user instead; they read it when quiet hours end.";
export const PAUSED_REFUSAL = "Refused: PPM Assistant has paused messaging manager chats on its own until the user replies. "
  + "Tell the user what you wanted to ask.";
export const DUPLICATE_REFUSAL = "Already sent: the same message went to this manager chat within the last hour, so it was not sent again.";
export const SECRET_REFUSAL = "Refused: the message looks like it holds a secret (a key, a token or a password), and nobody is here "
  + "to approve it. Tell the user instead, without the secret.";

const BUDGET_TEXT: Record<BudgetHit, string> = {
  hour: `its ${UNATTENDED_SENDS_PER_HOUR} messages an hour`,
  day: `its ${UNATTENDED_SENDS_PER_DAY} messages a day`,
  pair: "the limit of messages to one manager chat",
};

/** Whether `text` holds something PPM would hide from Telegram as a secret. */
export function looksLikeSecret(text: string): boolean {
  return redactSecretsForTelegram(text).hidden > 0;
}

const pairKey = (assistant: string, manager: string) => `${assistant} ${manager}`;
const hashOf = (text: string) => createHash("sha256").update(text.trim()).digest("hex");

export function createAssistantSendGuards(env: AssistantSendGuardsEnv) {
  let sends: Map<string, number[]> | null = null;
  let paused = new Set<string>();
  const pairs = new Map<string, number>();
  const recent = new Map<string, Array<{ hash: string; at: number }>>();

  const state = () => {
    if (sends) return sends;
    sends = new Map();
    try {
      const raw = JSON.parse(env.load() ?? "null") as { version?: number; sends?: Record<string, unknown>; paused?: unknown; pairs?: unknown } | null;
      if (raw?.version === 1) {
        for (const [id, list] of Object.entries(raw.sends ?? {})) {
          if (Array.isArray(list)) sends.set(id, list.filter((t): t is number => typeof t === "number" && Number.isFinite(t)));
        }
        if (Array.isArray(raw.paused)) paused = new Set(raw.paused.filter((id): id is string => typeof id === "string"));
        // The pair counts too: a restart must not give every pair its allowance again.
        if (raw.pairs && typeof raw.pairs === "object") {
          for (const [key, n] of Object.entries(raw.pairs as Record<string, unknown>)) {
            if (typeof n === "number" && Number.isInteger(n) && n > 0) pairs.set(key, n);
          }
        }
      }
    } catch { /* unreadable: start counting afresh */ }
    return sends;
  };
  const persist = () => {
    const now = env.now();
    const out: Record<string, number[]> = {};
    for (const [id, list] of state()) {
      const kept = list.filter((t) => now - t < DAY);
      if (kept.length) out[id] = kept;
    }
    const pairCounts = Object.fromEntries([...pairs].filter(([, n]) => n > 0));
    try { env.save(JSON.stringify({ version: 1, sends: out, paused: [...paused], pairs: pairCounts })); } catch { /* counted in memory still */ }
  };
  /** A quiet-hours check that cannot answer holds the message, as quiet hours would. */
  const quiet = (): boolean => {
    try { return env.quiet(); } catch { return true; }
  };
  const within = (list: number[], ms: number, now: number) => list.filter((t) => now - t < ms).length;

  function pause(assistant: string, reason: BudgetHit, message: string): Reservation {
    paused.add(assistant);
    persist();
    env.announce?.({ type: "paused", sessionId: assistant, reason });
    return { ok: false, reason, message: `Refused: PPM Assistant has used ${BUDGET_TEXT[reason]} on its own and is paused until the user replies. ${message}`, pausedNow: true };
  }

  return {
    /**
     * Counts one message to a manager in a turn nobody started, or says why it may not go. A
     * budget running out pauses the Assistant (`pausedNow` is true for the send that did it).
     */
    reserveUnattended(assistant: string, manager: string, pairLimit: number): Reservation {
      if (quiet()) return { ok: false, reason: "quiet", message: QUIET_HOURS_REFUSAL, pausedNow: false };
      const now = env.now();
      const list = (state().get(assistant) ?? []).filter((t) => now - t < DAY);
      state().set(assistant, list);
      if (paused.has(assistant)) return { ok: false, reason: "paused", message: PAUSED_REFUSAL, pausedNow: false };
      const ask = "Tell the user what you wanted to ask.";
      if (within(list, HOUR, now) >= UNATTENDED_SENDS_PER_HOUR) return pause(assistant, "hour", ask);
      if (within(list, DAY, now) >= UNATTENDED_SENDS_PER_DAY) return pause(assistant, "day", ask);
      const key = pairKey(assistant, manager);
      if ((pairs.get(key) ?? 0) >= pairLimit) return pause(assistant, "pair", ask);
      list.push(now);
      pairs.set(key, (pairs.get(key) ?? 0) + 1);
      persist();
      let held = true;
      return {
        ok: true,
        release: () => {
          if (!held) return;
          held = false;
          const current = state().get(assistant) ?? [];
          const at = current.lastIndexOf(now);
          if (at >= 0) current.splice(at, 1);
          pairs.set(key, Math.max(0, (pairs.get(key) ?? 1) - 1));
          persist();
        },
      };
    },

    /** Claims `body` for this manager unless the same text went within the hour; null when it did. */
    claimBody(assistant: string, manager: string, body: string): (() => void) | null {
      const key = pairKey(assistant, manager);
      const now = env.now();
      const hash = hashOf(body);
      const list = (recent.get(key) ?? []).filter((r) => now - r.at < DUPLICATE_SEND_WINDOW_MS);
      if (list.some((r) => r.hash === hash)) return null;
      const entry = { hash, at: now };
      list.push(entry);
      recent.set(key, list);
      return () => {
        const current = recent.get(key);
        const at = current?.indexOf(entry) ?? -1;
        if (current && at >= 0) current.splice(at, 1);
      };
    },

    /** The user wrote in `sessionId`: its pairs count afresh, and an Assistant paused there resumes. */
    userWrote(sessionId: string): void {
      state();
      let reset = false;
      for (const key of [...pairs.keys()]) if (key.split(" ").includes(sessionId)) { pairs.delete(key); reset = true; }
      const resumed = paused.delete(sessionId);
      if (reset || resumed) persist();
      if (!resumed) return;
      env.announce?.({ type: "resumed", sessionId });
    },

    isPaused(assistant: string): boolean {
      state();
      return paused.has(assistant);
    },

    /** Unattended messages this Assistant session sent in the last hour and day. */
    usage(assistant: string): { hour: number; day: number } {
      const list = state().get(assistant) ?? [];
      const now = env.now();
      return { hour: within(list, HOUR, now), day: within(list, DAY, now) };
    },
  };
}

export type AssistantSendGuards = ReturnType<typeof createAssistantSendGuards>;
