/**
 * How the old supervisor waits for its replacement during an upgrade.
 *
 * It used to know only one way out besides success: 30 seconds of polling status.json.
 * A replacement that dies at startup (a bad build, a failed migration) left the public
 * port without a server for that long, and the old supervisor then restored the server.
 * The replacement's own exit is now an answer too, so the old one takes over again at
 * once. Pure apart from the callbacks it is given, so it is unit-tested directly.
 */

export type ReplacementOutcome =
  | { kind: "replaced"; pid: number }
  | { kind: "exited"; code: number | null }
  | { kind: "timeout" };

export interface WaitForReplacementOptions {
  /** This (old) supervisor's PID: status.json names it until the replacement takes over. */
  oldPid: number;
  /** The supervisor PID status.json names now, or undefined when it cannot be read. */
  readSupervisorPid: () => number | undefined;
  /** The replacement's exit, once it has exited; null while it runs. */
  exited: () => { code: number | null } | null;
  timeoutMs: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export async function waitForReplacement(opts: WaitForReplacementOptions): Promise<ReplacementOutcome> {
  const pollMs = opts.pollMs ?? 1000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const start = Date.now();
  while (Date.now() - start < opts.timeoutMs) {
    await sleep(pollMs);
    // Status first: a replacement that took over and then exited still took over.
    const pid = opts.readSupervisorPid();
    if (pid && pid !== opts.oldPid) return { kind: "replaced", pid };
    const exit = opts.exited();
    if (exit) return { kind: "exited", code: exit.code };
  }
  return { kind: "timeout" };
}
