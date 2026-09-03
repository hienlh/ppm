/**
 * Pure serializing queue behind the collision-prompt dialog.
 *
 * Uploads and copy/move transfers both call `ctx.resolve()` — sometimes from several jobs
 * running at once (`uploadEntries`' bounded-concurrency queue). Before this module, the
 * dialog was a single React state slot: the second concurrent `resolve()` call silently
 * replaced whichever request was already showing, and the first job's promise never
 * settled — the queue stalled forever with a stuck "Uploading…" toast.
 *
 * Every request now queues here and only one shows at a time. "Apply to all" (set from the
 * dialog when a choice is made) short-circuits every request still queued *in the same
 * batch* without opening another prompt — see `startBatch`/`endBatch`.
 *
 * Pure and DOM-free on purpose, like `upload-queue.ts`: `use-collision-prompt.ts` is the
 * thin React hook wrapping this for re-render notifications.
 */

export interface CollisionRequest {
  name: string;
  destination: string;
}

export type CollisionChoice = "replace" | "keep-both" | "skip";

interface QueueItem {
  request: CollisionRequest;
  settle(choice: CollisionChoice): void;
}

export interface CollisionQueueSnapshot {
  request: CollisionRequest;
  /** How many more requests are queued behind this one — the dialog's "…and N more". */
  remaining: number;
}

export interface QueueSnapshot<TRequest> {
  request: TRequest;
  remaining: number;
}

/**
 * Generic one-at-a-time prompt queue: every `request()` call queues behind whatever is
 * already showing, `snapshot()` exposes only the head, and `choose()` answers it and
 * advances. Reused by anything that needs a single dialog serialized across concurrent
 * callers — `CollisionPromptQueue` below layers "apply to all" sticky choices on top of one
 * of these for collisions; the rarer permanent-overwrite confirm (no sticky concept needed)
 * uses one directly via `use-permanent-overwrite-prompt.ts`. Both prompts used to be a bare
 * `useState` slot each, with the same "second concurrent caller overwrites the first" race.
 */
export class SerialPromptQueue<TRequest, TChoice> {
  private queue: Array<{ request: TRequest; settle(choice: TChoice): void }> = [];

  /** Called whenever the queue or the visible request changes, so a React wrapper can
   *  re-render. Never called synchronously from inside the constructor. */
  constructor(private readonly onChange: () => void) {}

  request(request: TRequest): Promise<TChoice> {
    return new Promise((resolve) => {
      this.queue.push({ request, settle: resolve });
      this.onChange();
    });
  }

  snapshot(): QueueSnapshot<TRequest> | null {
    const head = this.queue[0];
    return head ? { request: head.request, remaining: this.queue.length - 1 } : null;
  }

  /** Answers the head request (if any) with `choice` and advances to the next. */
  choose(choice: TChoice): void {
    const item = this.queue.shift();
    if (!item) return;
    item.settle(choice);
    this.onChange();
  }

  /** Removes and answers every request currently queued (including the head) with the same
   *  `choice` — how "apply to all" resolves the rest of a batch in one step. */
  drain(choice: TChoice): void {
    const rest = this.queue.splice(0);
    if (rest.length === 0) return;
    for (const item of rest) item.settle(choice);
    this.onChange();
  }
}

export class CollisionPromptQueue {
  private readonly core: SerialPromptQueue<CollisionRequest, CollisionChoice>;
  private stickyChoice: CollisionChoice | null = null;
  private activeBatches = 0;

  constructor(onChange: () => void) {
    this.core = new SerialPromptQueue(onChange);
  }

  /**
   * Marks the start of one batch of parallel `resolve()` calls that should share a single
   * "apply to all" choice (one drop, one paste, one drag). Batches can overlap (a paste
   * started while a drag is still resolving); "apply to all" only resets once every
   * overlapping batch has called `endBatch`.
   */
  startBatch(): void {
    this.activeBatches++;
  }

  endBatch(): void {
    this.activeBatches = Math.max(0, this.activeBatches - 1);
    if (this.activeBatches === 0) this.stickyChoice = null;
  }

  /** Raises one collision. Resolves immediately (no dialog) if a prior "apply to all" choice
   *  is still sticky for the current batch; otherwise queues behind whatever is showing. */
  request(request: CollisionRequest): Promise<CollisionChoice> {
    if (this.stickyChoice) return Promise.resolve(this.stickyChoice);
    return this.core.request(request);
  }

  /** The request currently on screen, or `null` when nothing is queued. */
  snapshot(): CollisionQueueSnapshot | null {
    return this.core.snapshot();
  }

  /** Answers the request on screen. When `applyToAll` is set, the choice also settles every
   *  request still queued right now, and sticks for any that arrive before the batch ends. */
  choose(choice: CollisionChoice, applyToAll: boolean): void {
    if (applyToAll) {
      this.stickyChoice = choice;
      this.core.drain(choice);
    } else {
      this.core.choose(choice);
    }
  }
}
