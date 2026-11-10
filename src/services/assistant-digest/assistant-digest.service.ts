import { createLogger } from "../logger.ts";
import type { AssistantClock, Cancel } from "../assistant-wake/assistant-clock.ts";
import type { NewCard } from "../assistant-cards/assistant-cards.service.ts";
import { DIGEST_CLOSED, DIGEST_NOT_ASKED } from "../assistant-cards/manager-report-tool.ts";
import type { DigestSettings } from "../../shared/assistant-digest.ts";
import { buildDigestCard } from "./digest-card-assembly.ts";
import { digestZone, lastDigestFire, nextDigestFire } from "./digest-next-fire.ts";
import type { DigestRun, DigestStateStore } from "./digest-state.ts";

/**
 * The morning digest: once a day, at the user's time in the user's zone, PPM asks every manager
 * chat whose switch is on for a short status, collects the answers `report_to_assistant` brings
 * back, and puts them on one card when all are in or the deadline passes. The card goes out through
 * the cards' outbound gate (held in quiet hours) and wakes the main Assistant session once.
 *
 * One timer, armed for the computed fire time on the injectable clock; no polling. The ask goes
 * `later`, so it never joins a manager's running turn. The run is written before the first ask,
 * and a restart finishes it: an ask no turn of the manager ever took (a `later` message dies with
 * the CLI's input queue) is handed over once more before the deadline, and a run past its deadline
 * is put together at once.
 */

const log = createLogger("assistant-digest");

export const DIGEST_ANSWER_WINDOW_MS = 60 * 60_000;
/** A PPM that was off at the digest time runs it at startup within this long, else skips the day. */
export const DIGEST_CATCH_UP_MS = 3 * 60 * 60_000;

export interface DigestManager {
  projectKey: string;
  projectName: string;
  projectPath: string;
  sessionId: string;
  providerId: string;
  digest: boolean;
  /** The project keeps its details off the phone. */
  titleOnly: boolean;
}

export interface DigestDeps {
  clock: AssistantClock;
  settings(): { digest: DigestSettings; zone?: string };
  managers(): DigestManager[];
  /** The main Assistant session: the sender the asks name. */
  mainSession(): string | null;
  state: DigestStateStore;
  /** Hands the ask to the manager chat; whether it opened a turn there at once. */
  deliverAsk(manager: DigestManager, fromSession: string): Promise<{ clientMessageId: string; started: boolean }>;
  /** Hears the client id of every message a turn opened with. */
  onTurnBound(listener: (clientMessageId: string) => void): () => void;
  /** The digest card already made for this date (a crash between making it and recording it). */
  existingCard(date: string): string | null;
  createCard(card: NewCard): { id: string };
  canonical(sessionId: string): string;
}

export type DigestAnswer = { ok: true } | { ok: false; message: string };

export function createAssistantDigest(deps: DigestDeps) {
  let fireTimer: Cancel | null = null;
  let deadlineTimer: Cancel | null = null;
  let offBinding: (() => void) | null = null;
  let started = false;
  /** Client ids of asks not yet taken, so an unrelated turn never reads the state row. */
  const pending = new Map<string, string>();
  let chain: Promise<void> = Promise.resolve();
  const serial = (fn: () => Promise<void> | void): Promise<void> =>
    (chain = chain.then(fn).catch((e) => log.warn(`morning digest: ${(e as Error).message}`)));

  /** Reads, changes and writes the run in one synchronous step. */
  function update(change: (run: DigestRun) => void): DigestRun | null {
    const run = deps.state.read();
    if (!run) return null;
    change(run);
    deps.state.write(run);
    return run;
  }

  const askedKey = (run: DigestRun, sessionId: string): string | undefined => {
    const id = deps.canonical(sessionId);
    return Object.keys(run.asked).find((k) => deps.canonical(run.asked[k]!) === id);
  };

  function assemble(): void {
    const run = deps.state.read();
    if (!run || run.cardId) return;
    deadlineTimer?.();
    deadlineTimer = null;
    const detail = new Map(deps.managers().map((m) => [m.projectKey, m.titleOnly]));
    const id = deps.existingCard(run.date) ?? deps.createCard(buildDigestCard(run, (key) => detail.get(key) ?? false)).id;
    update((r) => { r.cardId = id; });
    for (const key of Object.keys(run.delivered)) pending.delete(run.delivered[key]!.clientMessageId);
    log.info(`morning digest ${run.date}: card ${id}, ${Object.keys(run.answers).length} of ${Object.keys(run.asked).length} answered`);
  }

  function armDeadline(run: DigestRun): void {
    deadlineTimer?.();
    deadlineTimer = deps.clock.setTimer(() => { deadlineTimer = null; void serial(assemble); }, run.deadline - deps.clock.now());
  }

  /** Hands the ask to each of these projects' managers, if it is still the chat that was asked. */
  async function ask(keys: string[], again: boolean): Promise<void> {
    const from = deps.mainSession();
    if (!from) return void log.warn("morning digest: no main Assistant session to ask from");
    for (const key of keys) {
      const run = deps.state.read();
      if (!run || run.cardId) return;
      const manager = deps.managers().find((m) => m.projectKey === key);
      if (!manager || deps.canonical(manager.sessionId) !== deps.canonical(run.asked[key] ?? "")) continue;
      // Recorded before the hand-over, so a crash in it never earns a third ask.
      if (again) update((r) => { r.redelivered[key] = true; });
      try {
        const out = await deps.deliverAsk(manager, from);
        update((r) => {
          r.delivered[key] = { clientMessageId: out.clientMessageId, at: deps.clock.now() };
          if (out.started) r.taken[key] = true;
        });
        if (!out.started) pending.set(out.clientMessageId, key);
      } catch (e) {
        log.warn(`morning digest: the ${manager.projectName} manager could not be asked: ${(e as Error).message}`);
      }
    }
  }

  async function runFor(date: string): Promise<void> {
    const previous = deps.state.read();
    if (previous?.date === date) return;
    if (previous && !previous.cardId) assemble();
    const managers = deps.managers().filter((m) => m.digest);
    if (managers.length === 0) return void log.info(`morning digest ${date}: no manager chat has it on`);
    if (!deps.mainSession()) return void log.warn(`morning digest ${date} skipped: there is no main Assistant session`);
    const now = deps.clock.now();
    const run: DigestRun = {
      date, startedAt: now, deadline: now + DIGEST_ANSWER_WINDOW_MS,
      asked: Object.fromEntries(managers.map((m) => [m.projectKey, m.sessionId])),
      names: Object.fromEntries(managers.map((m) => [m.projectKey, m.projectName])),
      delivered: {}, taken: {}, redelivered: {}, answers: {},
    };
    // Before any ask: a crash loop finds the run for this date and never starts it again.
    deps.state.write(run);
    log.info(`morning digest ${date}: asking ${managers.length} manager chat(s)`);
    armDeadline(run);
    await ask(Object.keys(run.asked), false);
  }

  /** After a restart: finish an open run, and run a digest the server was off for. */
  async function resume(): Promise<void> {
    const run = deps.state.read();
    if (run && !run.cardId) {
      for (const [key, d] of Object.entries(run.delivered)) if (!run.taken[key]) pending.set(d.clientMessageId, key);
      if (deps.clock.now() >= run.deadline) assemble();
      else {
        armDeadline(run);
        await ask(Object.keys(run.asked).filter((k) => !run.taken[k] && !run.answers[k] && !run.redelivered[k]), true);
      }
    }
    const { digest, zone } = deps.settings();
    if (!digest.enabled) return;
    const now = deps.clock.now();
    const last = lastDigestFire(now, digest.time, digestZone(zone));
    if (now - last.at <= DIGEST_CATCH_UP_MS) await runFor(last.date);
  }

  /** Arms the timer for the next fire after `from`; disarms it when the digest is off. */
  function arm(from = deps.clock.now()): void {
    fireTimer?.();
    fireTimer = null;
    const { digest, zone } = deps.settings();
    if (!started || !digest.enabled) return;
    const next = nextDigestFire(from, digest.time, digestZone(zone));
    fireTimer = deps.clock.setTimer(() => {
      fireTimer = null;
      void serial(() => runFor(next.date));
      arm(Math.max(deps.clock.now(), next.at));
    }, next.at - deps.clock.now());
  }

  function onBound(clientMessageId: string): void {
    const key = pending.get(clientMessageId);
    if (key === undefined) return;
    pending.delete(clientMessageId);
    update((r) => { if (r.delivered[key]?.clientMessageId === clientMessageId) r.taken[key] = true; });
  }

  return {
    start(): Promise<void> {
      if (started) return chain;
      started = true;
      offBinding = deps.onTurnBound(onBound);
      const done = serial(resume);
      arm();
      return done;
    },
    stop(): void {
      started = false;
      fireTimer?.();
      deadlineTimer?.();
      fireTimer = deadlineTimer = null;
      offBinding?.();
      offBinding = null;
      pending.clear();
    },
    /** Settings changed: the next fire is recomputed. */
    rearm: () => arm(),
    /** A manager's `report_to_assistant` with kind `digest`. */
    answer(sessionId: string, items: string[]): DigestAnswer {
      const run = deps.state.read();
      const key = run ? askedKey(run, sessionId) : undefined;
      if (!run || key === undefined) return { ok: false, message: DIGEST_NOT_ASKED };
      if (run.cardId || deps.clock.now() >= run.deadline) return { ok: false, message: DIGEST_CLOSED };
      const after = update((r) => { r.answers[key] = items; r.taken[key] = true; });
      if (after && Object.keys(after.asked).every((k) => after.answers[k])) assemble();
      return { ok: true };
    },
    /** Waits for whatever the digest is doing (tests). */
    settled: (): Promise<void> => chain,
  };
}

export type AssistantDigest = ReturnType<typeof createAssistantDigest>;
