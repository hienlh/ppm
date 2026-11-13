/**
 * Long-running calls an extension started on the main thread (a spawned process, an AI call,
 * an MCP round trip), grouped by the worker generation that asked for them.
 *
 * When the extension host worker is rebuilt, nobody is left to read the answers its old
 * generation is still waiting for — yet each call would keep running, holding a process or
 * spending quota, until it finished on its own. Ending a generation aborts every call it
 * registered, and a call that begins for a generation that has already ended is aborted at
 * once, so a handler that was mid-`await` when the worker went away cannot start work late.
 */
export interface ExtensionCall {
  readonly signal: AbortSignal;
  /** The call finished: stop tracking it. Safe to call more than once. */
  end(): void;
}

function rebuiltError(): Error {
  const error = new Error("Extension host was rebuilt; the call was cancelled");
  error.name = "AbortError";
  return error;
}

export class ExtensionCallRegistry {
  private live = new Map<number, Set<AbortController>>();
  /** Generations only grow, one per worker start, so this stays a handful of numbers. */
  private ended = new Set<number>();

  begin(generation: number): ExtensionCall {
    const controller = new AbortController();
    if (this.ended.has(generation)) {
      controller.abort(rebuiltError());
      return { signal: controller.signal, end: () => {} };
    }
    let calls = this.live.get(generation);
    if (!calls) this.live.set(generation, calls = new Set());
    calls.add(controller);
    return {
      signal: controller.signal,
      end: () => {
        const current = this.live.get(generation);
        if (!current?.delete(controller)) return;
        if (current.size === 0) this.live.delete(generation);
      },
    };
  }

  /** Abort every call of `generation` and refuse new ones. Returns how many were aborted. */
  endGeneration(generation: number): number {
    this.ended.add(generation);
    const calls = this.live.get(generation);
    this.live.delete(generation);
    if (!calls) return 0;
    for (const controller of calls) controller.abort(rebuiltError());
    return calls.size;
  }

  /** Calls still running, for one generation or all of them. */
  count(generation?: number): number {
    if (generation !== undefined) return this.live.get(generation)?.size ?? 0;
    let total = 0;
    for (const calls of this.live.values()) total += calls.size;
    return total;
  }
}

/** The registry the extension service and every main-side handler share. */
export const extensionCallRegistry = new ExtensionCallRegistry();
