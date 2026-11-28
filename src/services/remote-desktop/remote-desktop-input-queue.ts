/**
 * One session's input, injected in the order it arrived.
 *
 * Bun does not wait for a WebSocket message handler before calling it with the next message, so
 * every input message used to start its own injection at once. Where an injection takes time
 * the next one overtook it: X11 types a character missing from the keymap by rebinding a spare
 * key and waiting ~12 ms twice, so a Backspace or Enter sent right after a Vietnamese letter
 * landed before it, and the host's text came out reordered. The phone keyboard sends a
 * Backspace-then-letter pair for every Telex or autocorrect rewrite, which made that ordinary.
 *
 * A failure rejects that call only; the chain carries on with the next.
 */
export interface InputQueue {
  run<T>(task: () => Promise<T>): Promise<T>;
}

export function createInputQueue(): InputQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      const next = tail.then(task);
      tail = next.catch(() => undefined);
      return next;
    },
  };
}
