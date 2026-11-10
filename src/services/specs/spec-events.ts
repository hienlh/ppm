/**
 * Spec change notifications, in the shape of `git-events.ts`: the spec service emits, and
 * `ws/global.ts` relays each one to browsers (with the project's name) so an open Spec tab and
 * the sidebar refresh.
 */
export type SpecEvent =
  | { type: "spec:changed"; projectPath: string; slug: string }
  /** The AI asked for the spec's drawing: open its design for the user. */
  | { type: "spec:open-design"; projectPath: string; slug: string; designSlug: string };

type Callback = (event: SpecEvent) => void;
const callbacks = new Set<Callback>();

export function onSpecEvent(cb: Callback): () => void {
  callbacks.add(cb);
  return () => { callbacks.delete(cb); };
}

export function emitSpecEvent(event: SpecEvent): void {
  for (const cb of callbacks) {
    try {
      cb(event);
    } catch (e) {
      console.warn(`[spec] ${event.type} subscriber failed: ${(e as Error).message}`);
    }
  }
}
