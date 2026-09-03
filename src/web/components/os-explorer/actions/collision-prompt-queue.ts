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

export class CollisionPromptQueue {
  private queue: QueueItem[] = [];
  private stickyChoice: CollisionChoice | null = null;
  private activeBatches = 0;

  /** Called whenever the queue or the visible request changes, so the React wrapper can
   *  re-render. Never called synchronously from inside the constructor. */
  constructor(private readonly onChange: () => void) {}

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
    return new Promise((resolve) => {
      if (this.stickyChoice) {
        resolve(this.stickyChoice);
        return;
      }
      this.queue.push({ request, settle: resolve });
      this.onChange();
    });
  }

  /** The request currently on screen, or `null` when nothing is queued. */
  snapshot(): CollisionQueueSnapshot | null {
    const head = this.queue[0];
    return head ? { request: head.request, remaining: this.queue.length - 1 } : null;
  }

  /** Answers the request on screen. When `applyToAll` is set, the choice also settles every
   *  request still queued right now, and sticks for any that arrive before the batch ends. */
  choose(choice: CollisionChoice, applyToAll: boolean): void {
    const item = this.queue.shift();
    if (!item) return;
    if (applyToAll) this.stickyChoice = choice;
    item.settle(choice);
    if (this.stickyChoice) {
      for (const rest of this.queue.splice(0)) rest.settle(this.stickyChoice);
    }
    this.onChange();
  }
}
