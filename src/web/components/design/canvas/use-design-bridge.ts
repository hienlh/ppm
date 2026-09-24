import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  parentEnvelope, parseChildMessage, parseParentMessage,
  type ChildMessage, type ChildMessageType, type ParentMessage,
} from "../../../../shared/design-bridge-protocol";

/**
 * The parent side of the design bridge: which frame messages are believed, how to talk
 * back, and what to redo every time the frame starts over.
 *
 * A message from the frame is accepted only when it comes from the iframe's current
 * `contentWindow` AND carries the nonce minted for the current load. The source check alone
 * is not enough: a frame that navigated itself to a foreign page is still the same
 * `contentWindow`, but that page never saw the nonce — parent → frame messages never carry
 * one (see `design-bridge-protocol.ts`), and none goes out at all while the frame looks dead
 * (loaded but not yet proven itself with `ready`), which is the only window such a page could
 * otherwise use to snoop one off the wire and echo it back to forge its own `ready`. A stale
 * nonce (a message from the document before a reload) is dropped the same way.
 *
 * Every `ready` is a brand-new document — a live reload, a token rotation, or the tab pool
 * moving the tab to another panel (which reloads any iframe it reparents). Features register
 * a replay callback to restore their state (scroll, modes, pins) on each one.
 */

export type ReadyMessage = Extract<ChildMessage, { type: "ready" }>;
type Handler<T extends ChildMessageType> = (message: Extract<ChildMessage, { type: T }>) => void;
export type BridgeSend = (message: ParentMessage) => boolean;

export interface BridgeExpectation {
  contentWindow: unknown;
  nonce: string | null;
}

/** The accept rule, pure so it can be tested without a frame: source, shape, then nonce. */
export function acceptBridgeEvent(event: { source: unknown; data: unknown }, expected: BridgeExpectation): ChildMessage | null {
  if (!expected.contentWindow || event.source !== expected.contentWindow) return null;
  const message = parseChildMessage(event.data);
  if (!message) return null;
  if (!expected.nonce || message.nonce !== expected.nonce) return null;
  return message;
}

/** 16 random bytes as base64url: 22 characters, inside the protocol's nonce shape. */
export function newBridgeNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** How long a document may take to say `ready` after its `load` before the canvas is dead. */
export const BRIDGE_LIVENESS_MS = 3000;

/**
 * Whether the frame is showing a document that never said `ready`.
 *
 * Counted rather than flagged, because the two events race: `ready` is posted at
 * DOMContentLoaded and usually lands *before* the iframe's `load`, but a slow parent can see
 * them the other way round. Every genuine document produces one of each; a page the frame
 * navigated to on its own (or an error page) produces a `load` and nothing else.
 */
export function frameLooksDead(loads: number, readies: number): boolean {
  return loads > readies;
}

export interface DesignBridge {
  send: BridgeSend;
  on<T extends ChildMessageType>(type: T, handler: Handler<T>): () => void;
  /** Runs on every `ready`, after the frame reports it; returns the unregister function. */
  onReplay(replay: (send: BridgeSend, ready: ReadyMessage) => void): () => void;
  /** The last `ready` of the current load, or null while the frame is (re)loading. */
  ready: ReadyMessage | null;
  /** Call from the iframe's `load` event: starts the liveness clock for this document. */
  frameLoaded(): void;
}

export function useDesignBridge(
  iframeRef: RefObject<HTMLIFrameElement | null>,
  nonce: string | null,
  onDead: () => void,
): DesignBridge {
  const [ready, setReady] = useState<ReadyMessage | null>(null);
  const nonceRef = useRef(nonce);
  const handlers = useRef(new Map<string, Set<(m: ChildMessage) => void>>());
  const replays = useRef(new Set<(send: BridgeSend, ready: ReadyMessage) => void>());
  const livenessTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const counts = useRef({ loads: 0, readies: 0 });
  const onDeadRef = useRef(onDead);
  onDeadRef.current = onDead;

  const clearLiveness = useCallback(() => {
    if (livenessTimer.current) clearTimeout(livenessTimer.current);
    livenessTimer.current = null;
  }, []);

  // A new nonce means a new load is on its way: nothing from the old document counts now.
  // Its liveness clock goes too, or it would judge the new document by the old one's load.
  useEffect(() => {
    nonceRef.current = nonce;
    counts.current = { loads: 0, readies: 0 };
    clearLiveness();
    setReady(null);
  }, [nonce, clearLiveness]);

  const send = useCallback<BridgeSend>((message) => {
    const win = iframeRef.current?.contentWindow;
    if (!win || !nonceRef.current) return false;
    // A load that fired `load` without a `ready` yet might already be showing a page the
    // frame navigated itself to. Nothing goes out until the real document proves itself, or
    // there would be a window where a parent message reaches that foreign page instead.
    if (frameLooksDead(counts.current.loads, counts.current.readies)) return false;
    const envelope = parentEnvelope(message);
    // Validated before it leaves, so a feature cannot post a shape the bridge would reject.
    if (!parseParentMessage(envelope)) return false;
    // "*": the frame's origin is opaque, and nothing sensitive ever goes this way.
    win.postMessage(envelope, "*");
    return true;
  }, [iframeRef]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const message = acceptBridgeEvent(event, {
        contentWindow: iframeRef.current?.contentWindow ?? null, nonce: nonceRef.current,
      });
      if (!message) return;
      if (message.type === "ready") {
        counts.current.readies++;
        if (!frameLooksDead(counts.current.loads, counts.current.readies)) clearLiveness();
        setReady(message);
        for (const replay of replays.current) {
          try { replay(send, message); } catch (e) { console.warn("[design] replay failed:", e); }
        }
      }
      for (const handler of handlers.current.get(message.type) ?? []) {
        try { handler(message); } catch (e) { console.warn(`[design] ${message.type} handler failed:`, e); }
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [iframeRef, send, clearLiveness]);

  useEffect(() => clearLiveness, [clearLiveness]);

  const frameLoaded = useCallback(() => {
    counts.current.loads++;
    if (!frameLooksDead(counts.current.loads, counts.current.readies)) return;
    clearLiveness();
    livenessTimer.current = setTimeout(() => {
      livenessTimer.current = null;
      if (frameLooksDead(counts.current.loads, counts.current.readies)) onDeadRef.current();
    }, BRIDGE_LIVENESS_MS);
  }, [clearLiveness]);

  const on = useCallback(<T extends ChildMessageType>(type: T, handler: Handler<T>) => {
    const set = handlers.current.get(type) ?? new Set();
    const wrapped = handler as (m: ChildMessage) => void;
    set.add(wrapped);
    handlers.current.set(type, set);
    return () => { set.delete(wrapped); };
  }, []);

  const onReplay = useCallback((replay: (send: BridgeSend, ready: ReadyMessage) => void) => {
    replays.current.add(replay);
    return () => { replays.current.delete(replay); };
  }, []);

  return useMemo(() => ({ send, on, onReplay, ready, frameLoaded }), [send, on, onReplay, ready, frameLoaded]);
}
