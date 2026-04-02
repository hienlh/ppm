import { Disposable } from "./disposable.ts";

/** VSCode-compatible Event type */
export type Event<T> = (listener: (e: T) => void, thisArgs?: unknown) => Disposable;

/** VSCode-compatible EventEmitter */
export class EventEmitter<T> {
  private listeners = new Set<(e: T) => void>();

  /** The event that listeners can subscribe to */
  readonly event: Event<T> = (listener: (e: T) => void): Disposable => {
    this.listeners.add(listener);
    return new Disposable(() => this.listeners.delete(listener));
  };

  /** Fire the event, notifying all listeners */
  fire(data: T): void {
    for (const listener of this.listeners) {
      try { listener(data); } catch (e) {
        console.error("[EventEmitter] Listener error:", e);
      }
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}
