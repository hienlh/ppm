/** What `alongside` yields instead of a message when only the queue has something to hand out. */
export const APPROVAL_WAKE = Symbol("approval-wake");

/**
 * Approval requests raised from the CLI's callbacks (`canUseTool`, the PreToolUse hook), for the
 * turn's loop over the CLI's messages to hand out.
 *
 * The CLI asks through a control request and then says nothing until it is answered, so a queue
 * looked at only when the next message arrives can wait forever: an AskUserQuestion stayed behind
 * a thinking spinner for 17 minutes, until the user cancelled. Whether the turn's last message
 * landed before or after the callback ran decided it, which is why it looked intermittent.
 */
export class ApprovalQueue<E> {
  private readonly queued: E[] = [];
  private wake: (() => void) | undefined;

  push(event: E): void {
    this.queued.push(event);
    this.wake?.();
  }

  *drain(): Generator<E> {
    while (this.queued.length > 0) yield this.queued.shift()!;
  }

  /**
   * `source`'s items, plus `APPROVAL_WAKE` whenever something is queued and `source` has nothing
   * to give. The caller must drain the queue on a wake, or it is woken again at once.
   */
  async *alongside<T>(source: AsyncIterable<T>): AsyncGenerator<T | typeof APPROVAL_WAKE> {
    const it = source[Symbol.asyncIterator]();
    // Kept across wakes: a second next() would hand this item to a promise nobody reads.
    let next: Promise<IteratorResult<T>> | undefined;
    // Closed on an early exit, as `for await` closes it: not once it has ended or thrown.
    let open = true;
    try {
      for (;;) {
        if (this.queued.length > 0) {
          yield APPROVAL_WAKE;
          continue;
        }
        const pending = (next ??= it.next());
        let got: IteratorResult<T> | typeof APPROVAL_WAKE;
        try {
          got = await new Promise<IteratorResult<T> | typeof APPROVAL_WAKE>((resolve, reject) => {
            this.wake = () => resolve(APPROVAL_WAKE);
            // next() may have run a callback that queued something before there was a wake to call.
            if (this.queued.length > 0) this.wake();
            pending.then(resolve, reject);
          });
        } catch (e) {
          open = false;
          throw e;
        } finally {
          this.wake = undefined;
        }
        if (got === APPROVAL_WAKE) continue;
        next = undefined;
        if (got.done) {
          open = false;
          return;
        }
        yield got.value;
      }
    } finally {
      if (open && next) {
        // Not awaited: an async generator's return() waits behind the next() still out, which
        // the CLI answers only after the approval it is waiting on.
        Promise.resolve().then(() => it.return?.()).catch(() => {});
      } else if (open) {
        await it.return?.();
      }
    }
  }
}
