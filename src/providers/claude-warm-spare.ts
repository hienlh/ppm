/**
 * A Claude CLI started before the chat that will use it exists.
 *
 * A new chat's first message used to wait for the CLI to boot before anything reached the
 * API. Measured against a local stub API, so the figure is the CLI's own: 1.33–1.53 s from
 * the message to the request, against 37–43 ms for a CLI started a few seconds earlier and
 * waiting on stdin. The price is ~500 MB of RAM (the CLI plus the MCP servers it starts)
 * and ~2.5% of a core while it waits — hence spares exist only while a new-chat composer is
 * open, expire when nobody touches it, and are capped.
 *
 * A spare is spawned under a session id chosen now. `claim` hands that id to the next chat
 * created in the project, and that chat's first turn takes the process over through `adopt`
 * — but only when every option it would spawn a CLI with is the one the spare was spawned
 * with. Any difference (another model, a rotated token, an edited MCP list) closes the spare
 * and the turn starts cold, so a stale spare can cost the speed-up but never the behaviour.
 * A spare closed unused has written nothing (the CLI creates the transcript on the first
 * message), which is what lets its id go on to a cold start.
 */
import { createHash } from "node:crypto";

/** The per-turn callbacks a CLI is spawned with. A spare's forward to the turn that adopts it. */
export interface SpareHandlers {
  canUseTool: (...args: any[]) => Promise<any>;
  preToolUse: (...args: any[]) => Promise<any>;
  /** Keeps a file's state before the session's first write to it (see `buildToolHooks`). */
  fileWrite: (...args: any[]) => Promise<any>;
  /** Brackets a shell command with `git status` for the same purpose. */
  shellCommand: (...args: any[]) => Promise<any>;
  stderr: (chunk: string) => void;
}

export interface SpareProcess<Q> {
  query: Q;
  controller: { push(msg: unknown): void; done(): void };
}

interface Spare<Q> extends SpareProcess<Q> {
  key: string;
  sessionId: string;
  fingerprint: string;
  startedAt: number;
  claimed: boolean;
  handlers?: SpareHandlers;
  /** What the CLI wrote to stderr before a turn took it, handed to that turn's handler. */
  stderr: string;
  timer?: ReturnType<typeof setTimeout>;
}

export interface WarmSpareLimits {
  /** How long a spare nobody claims stays, from the last `offer` for its key. */
  idleMs: number;
  /** How long a claimed spare waits for its session's first message. */
  claimedMs: number;
  /** Spares alive at once, across every project. */
  max: number;
}

const DEFAULT_LIMITS: WarmSpareLimits = { idleMs: 5 * 60_000, claimedMs: 60_000, max: 2 };

export class WarmSpares<Q extends { close(): void; initializationResult?(): Promise<unknown> }> {
  private readonly spares = new Map<string, Spare<Q>>();

  constructor(private readonly limits: WarmSpareLimits = DEFAULT_LIMITS) {}

  /**
   * Keep a spare ready for `key`. One already waiting there with the same fingerprint is kept
   * and its expiry pushed back; one with any other is replaced. Returns the waiting spare's
   * session id.
   */
  offer(key: string, fingerprint: string, start: (sessionId: string, callbacks: SpareHandlers) => SpareProcess<Q>): string {
    const waiting = this.waiting(key);
    if (waiting?.fingerprint === fingerprint) {
      this.expireIn(waiting, this.limits.idleMs);
      return waiting.sessionId;
    }
    if (waiting) this.close(waiting);
    // Oldest first, and a claimed spare last: its first message is at most seconds away.
    for (const victim of [...this.spares.values()].sort((a, b) => Number(a.claimed) - Number(b.claimed))) {
      if (this.spares.size < this.limits.max) break;
      this.close(victim);
    }

    const spare: Spare<Q> = {
      key, fingerprint, sessionId: crypto.randomUUID(), startedAt: Date.now(), claimed: false, stderr: "",
    } as Spare<Q>;
    const callbacks: SpareHandlers = {
      // Nothing can ask before a turn has pushed a message; refusing is the safe answer anyway.
      canUseTool: (...args) => spare.handlers
        ? spare.handlers.canUseTool(...args)
        : Promise.resolve({ behavior: "deny", message: "No turn has taken this process over yet" }),
      preToolUse: (...args) => spare.handlers ? spare.handlers.preToolUse(...args) : Promise.resolve({}),
      fileWrite: (...args) => spare.handlers ? spare.handlers.fileWrite(...args) : Promise.resolve({}),
      shellCommand: (...args) => spare.handlers ? spare.handlers.shellCommand(...args) : Promise.resolve({}),
      stderr: (chunk) => {
        if (spare.handlers) spare.handlers.stderr(chunk);
        else spare.stderr = (spare.stderr + chunk).slice(-2048);
      },
    };
    Object.assign(spare, start(spare.sessionId, callbacks));
    this.spares.set(spare.sessionId, spare);
    this.expireIn(spare, this.limits.idleMs);
    // A CLI that dies during startup (a broken MCP entry, a missing binary) says so here;
    // dropping it keeps a turn from adopting a process that is already gone.
    spare.query.initializationResult?.().catch(() => {
      if (this.spares.get(spare.sessionId) === spare) this.close(spare);
    });
    return spare.sessionId;
  }

  /** Hand the spare waiting for `key` to the session being created there. */
  claim(key: string): string | undefined {
    const spare = this.waiting(key);
    if (!spare) return undefined;
    spare.claimed = true;
    this.expireIn(spare, this.limits.claimedMs);
    return spare.sessionId;
  }

  /**
   * Take over the spare started for `sessionId`, if the turn would have spawned exactly it.
   * One that differs is closed rather than kept: its session is starting cold, and no other
   * session can have its id.
   */
  adopt(sessionId: string, fingerprint: string, handlers: SpareHandlers): (SpareProcess<Q> & { ageMs: number }) | undefined {
    const spare = this.spares.get(sessionId);
    if (!spare) return undefined;
    this.forget(spare);
    if (spare.fingerprint !== fingerprint) {
      console.log(`[sdk] session=${sessionId} warm CLI does not match this turn's options — starting cold`);
      this.stop(spare);
      return undefined;
    }
    spare.handlers = handlers;
    if (spare.stderr) handlers.stderr(spare.stderr);
    return { query: spare.query, controller: spare.controller, ageMs: Date.now() - spare.startedAt };
  }

  closeAll(): void {
    for (const spare of [...this.spares.values()]) this.close(spare);
  }

  private waiting(key: string): Spare<Q> | undefined {
    for (const spare of this.spares.values()) if (spare.key === key && !spare.claimed) return spare;
    return undefined;
  }

  private expireIn(spare: Spare<Q>, ms: number): void {
    clearTimeout(spare.timer);
    spare.timer = setTimeout(() => this.close(spare), ms);
    spare.timer.unref?.();
  }

  private close(spare: Spare<Q>): void {
    this.forget(spare);
    this.stop(spare);
  }

  private forget(spare: Spare<Q>): void {
    clearTimeout(spare.timer);
    this.spares.delete(spare.sessionId);
  }

  private stop(spare: Spare<Q>): void {
    spare.controller.done();
    spare.query.close();
  }
}

/**
 * A digest of every option a CLI is spawned with but its session id. Functions do not
 * serialise and have no say; everything else — the environment and its token included —
 * does, which is also why this is a digest and not the text.
 */
export function spawnFingerprint(options: Record<string, unknown>): string {
  const { sessionId: _sessionId, ...rest } = options;
  return createHash("sha256").update(JSON.stringify(rest, sortKeys)).digest("hex");
}

function sortKeys(_key: string, value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
