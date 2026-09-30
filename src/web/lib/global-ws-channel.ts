/**
 * Tiny synchronisation point between `useGlobalEvents`'s socket and every other hook that
 * needs to send on `/ws/global` without holding a `WsClient` reference of its own.
 *
 * Deliberately not a queue: `WsClient.send` already queues a message while the socket is
 * still connecting and flushes it on open, which is exactly wrong for a subscription —
 * flushing a stale `agent-transcript:subscribe` after the fact would resume from whatever
 * cursor it was built with, not the latest one the caller has since applied. `sendIfOpen`
 * drops instead, and every caller re-sends explicitly from `onGlobalReady` using whatever
 * cursor it holds at that moment.
 */
import type { WsClient } from "./ws-client";

type ReadyListener = () => void;

let client: WsClient | null = null;
const readyListeners = new Set<ReadyListener>();

/** Called by `useGlobalEvents` to register (or clear, on teardown) the socket every other
 *  hook sends through. */
export function setGlobalWsClient(next: WsClient | null): void {
  client = next;
}

/** Send now, or drop — never queue. Returns whether the message actually went out. */
export function sendIfOpen(message: string): boolean {
  if (!client?.isConnected) return false;
  client.send(message);
  return true;
}

/** Fires on every `global_ready` (initial connect and every reconnect). */
export function onGlobalReady(listener: ReadyListener): () => void {
  readyListeners.add(listener);
  return () => readyListeners.delete(listener);
}

/** Called by `useGlobalEvents` when the server confirms the socket is ready. */
export function notifyGlobalReady(): void {
  for (const listener of readyListeners) listener();
}
