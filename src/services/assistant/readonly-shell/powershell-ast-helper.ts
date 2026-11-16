import { createLogger, type Logger } from "../../logger.ts";
import { POWERSHELL_AST_HELPER_SCRIPT } from "./powershell-ast-helper-script.ts";
import type { PsParseReply } from "./powershell-ast-types.ts";
import {
  defaultSpawner, drain, encodeAstRequest, findPowerShellExecutable, parseReplyLine, readReplyLines, toReply,
  type AstHelperChild, type AstHelperSpawner,
} from "./powershell-ast-helper-process.ts";

export { findPowerShellExecutable, type AstHelperChild, type AstHelperSpawner } from "./powershell-ast-helper-process.ts";

/**
 * ONE long-lived PowerShell process that parses scripts for the read-only judge.
 *
 * On Windows every `powershell.exe` spawn costs Bun a 32 MiB allocator segment it never returns
 * (and ~0.3 s). So the helper starts on first use and then stays for the server's life: an idle
 * exit would make every later burst of commands pay for a respawn, and after three of them the
 * leaked segments outweigh the ~95 MiB the resident helper costs. Only a failure (a crash, a hung
 * request, garbage on stdout) ends the child; it is restarted after a growing back-off and only a
 * fixed number of times for the server's life — a refilling budget would keep respawning against
 * a host where PowerShell is broken.
 *
 * Requests are served one at a time. Every failure (no PowerShell, a crash, a timeout, a malformed
 * reply) resolves as a failed parse, which the judge turns into `ask`; `parse` never rejects.
 */

export interface PowerShellAstHelperOptions {
  spawn?: AstHelperSpawner;
  /** The interpreter to start; the provider's own choice by default (`findPowerShellExecutable`). */
  executable?: () => string | null;
  /** How long one script may wait for its tree, queueing and a cold start included. */
  requestTimeoutMs?: number;
  /** How long a starting helper may take to say it is ready before it is killed. */
  startTimeoutMs?: number;
  /** Abnormal exits tolerated for the server's whole life before the helper is given up on. */
  maxRestarts?: number;
  backoffBaseMs?: number;
  now?: () => number;
  log?: Logger;
}

interface Pending { id: string; script: string; resolve: (r: PsParseReply) => void; timer: ReturnType<typeof setTimeout> }

const MAX_BACKOFF_MS = 5 * 60 * 1000;

export class PowerShellAstHelper {
  private readonly opts: Required<Omit<PowerShellAstHelperOptions, "log">> & { log: Logger };
  private child: AstHelperChild | null = null;
  private generation = 0;
  private ready = false;
  private psVersion = "";
  private stderrTail = "";
  private queue: Pending[] = [];
  private inflight: Pending | null = null;
  private nextId = 1;
  private restarts = 0;
  private disabled = false;
  private nextStartAt = 0;
  private startTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: PowerShellAstHelperOptions = {}) {
    this.opts = {
      spawn: opts.spawn ?? defaultSpawner,
      executable: opts.executable ?? (() => findPowerShellExecutable()),
      requestTimeoutMs: opts.requestTimeoutMs ?? 1500,
      startTimeoutMs: opts.startTimeoutMs ?? 15_000,
      maxRestarts: opts.maxRestarts ?? 5,
      backoffBaseMs: opts.backoffBaseMs ?? 2000,
      now: opts.now ?? Date.now,
      log: opts.log ?? createLogger("AssistantPowerShellParser"),
    };
  }

  childPid(): number | null { return this.child?.pid ?? null; }
  isDisabled(): boolean { return this.disabled; }

  /** Parses `script`; resolves with the tree or with why there is none. Never rejects. */
  parse(script: string): Promise<PsParseReply> {
    const fail = (error: string) => Promise.resolve<PsParseReply>({ ok: false, error });
    if (this.disabled) return fail("the PowerShell parser was given up on after repeated failures");
    if (!this.child) {
      if (this.opts.now() < this.nextStartAt) return fail("the PowerShell parser is waiting to restart after a failure");
      const started = this.start();
      if (started) return fail(started);
    }
    return new Promise<PsParseReply>((resolve) => {
      const pending: Pending = { id: String(this.nextId++), script, resolve, timer: undefined as unknown as ReturnType<typeof setTimeout> };
      pending.timer = setTimeout(() => {
        if (this.inflight === pending) this.onFailure(`a parse took longer than ${this.opts.requestTimeoutMs} ms`);
        else {
          this.queue = this.queue.filter((p) => p !== pending);
          resolve({ ok: false, error: `the PowerShell parser did not answer within ${this.opts.requestTimeoutMs} ms` });
        }
      }, this.opts.requestTimeoutMs);
      this.queue.push(pending);
      this.writeNext();
    });
  }

  /** Stops the child and fails whatever waits (server shutdown, tests). The next parse restarts it. */
  stop(): void {
    if (this.child) this.opts.log.info(`PowerShell parser stopped pid=${this.child.pid}`);
    this.teardown("the PowerShell parser was stopped");
  }

  /** Starts a child; returns why it could not, after counting a failed spawn as a failure. */
  private start(): string | null {
    const exe = this.opts.executable();
    if (!exe) return "no PowerShell is installed";
    const encoded = Buffer.from(POWERSHELL_AST_HELPER_SCRIPT, "utf16le").toString("base64");
    let child: AstHelperChild;
    try {
      child = this.opts.spawn([exe, "-NoProfile", "-NonInteractive", "-NoLogo", "-EncodedCommand", encoded]);
    } catch (e) {
      this.onFailure(`PowerShell could not be started: ${(e as Error).message}`);
      return "PowerShell could not be started";
    }
    const gen = ++this.generation;
    const current = () => gen === this.generation;
    this.child = child;
    this.ready = false;
    this.stderrTail = "";
    this.opts.log.info(`PowerShell parser started pid=${child.pid} exe=${exe}`);
    this.startTimer = setTimeout(() => this.onFailure(`PowerShell did not start within ${this.opts.startTimeoutMs} ms`), this.opts.startTimeoutMs);
    void readReplyLines(child.stdout, current, (line) => this.onLine(line)).then((why) => { if (current()) this.onFailure(why); });
    void drain(child.stderr, (text) => { if (current()) this.stderrTail = (this.stderrTail + text).slice(-300); });
    const exited = () => { if (current()) this.onFailure("PowerShell exited"); };
    child.exited.then(exited, exited);
    return null;
  }

  private onLine(line: string): void {
    const msg = parseReplyLine(line);
    if (!msg) return this.onFailure("PowerShell wrote a line that is not a reply");
    if (!this.ready) {
      if (msg.ready !== true) return this.onFailure("PowerShell did not greet as the parser");
      this.ready = true;
      this.psVersion = typeof msg.ps === "string" ? msg.ps : "";
      if (this.startTimer) clearTimeout(this.startTimer);
      this.startTimer = null;
      return this.writeNext();
    }
    const pending = this.inflight;
    if (!pending || msg.id !== pending.id) return; // a reply to a request that already gave up
    this.inflight = null;
    clearTimeout(pending.timer);
    pending.resolve(toReply(msg, this.psVersion));
    this.writeNext();
  }

  private writeNext(): void {
    if (!this.child || !this.ready || this.inflight) return;
    const next = this.queue.shift();
    if (!next) return;
    this.inflight = next;
    try {
      this.child.stdin.write(encodeAstRequest(next.id, next.script));
      this.child.stdin.flush?.();
    } catch (e) {
      this.onFailure(`writing to PowerShell failed: ${(e as Error).message}`);
    }
  }

  /** A crash, hang or garbage: kill, fail everything waiting, and hold off the next start. */
  private onFailure(reason: string): void {
    const stderr = this.stderrTail.replace(/\s+/g, " ").trim();
    this.restarts++;
    this.opts.log.warn(`PowerShell parser failed: ${reason} pid=${this.child?.pid ?? "?"} failures=${this.restarts}/${this.opts.maxRestarts}${stderr ? `: ${stderr}` : ""}`);
    this.teardown(reason);
    if (this.restarts >= this.opts.maxRestarts) {
      this.disabled = true;
      this.opts.log.error(`PowerShell parser given up after ${this.restarts} failures; PowerShell commands will ask`);
    } else {
      this.nextStartAt = this.opts.now() + Math.min(this.opts.backoffBaseMs * 2 ** (this.restarts - 1), MAX_BACKOFF_MS);
    }
  }

  private teardown(reason: string): void {
    const child = this.child;
    this.child = null;
    this.generation++;
    this.ready = false;
    if (this.startTimer) clearTimeout(this.startTimer);
    this.startTimer = null;
    const waiting = this.inflight ? [this.inflight, ...this.queue] : this.queue;
    this.inflight = null;
    this.queue = [];
    for (const p of waiting) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, error: reason });
    }
    if (child) { try { child.kill(); } catch { /* already gone */ } }
  }
}

let shared: PowerShellAstHelper | undefined;

/** The process-wide helper every classification shares. */
export function sharedPowerShellAstHelper(): PowerShellAstHelper {
  return (shared ??= new PowerShellAstHelper());
}
