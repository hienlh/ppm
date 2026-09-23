import { useEffect, useMemo, useRef, useState } from "react";
import type { DesignBridge } from "../canvas/use-design-bridge";
import type { PinRect } from "../../../../shared/design-bridge-messages-picker";
import type { DesignComment } from "../../../../shared/design-comment-types";
import type { CommentPatch } from "@/lib/design/api-design-comments";

/**
 * Keeps the frame told which comments to pin, and turns its answers into pin positions.
 *
 * The anchors go to the frame on every change and on every new document (`pins-set`); the
 * frame answers `pins-rects`. A pin the frame found by its text rather than its id comes
 * back `reanchored` with the element's current id, which is only a *proposal*: it is sent
 * to the server, which re-checks it against the source. Refused (409) means the pin is
 * shown as detached for this document instead of on an element the server does not
 * recognise. Each proposal is made once per load, so a refusal cannot loop.
 *
 * Only comments on the page the frame is showing are sent: a multi-page design's other
 * pages would otherwise be matched by text against this one.
 */

/** `elsewhere`: the comment is on another page of the design than the one on screen. */
export type PinStatus = "pinned" | "moved" | "detached" | "pending" | "elsewhere";

export interface CommentPins {
  rects: ReadonlyMap<string, PinRect>;
  statusOf: (id: string) => PinStatus;
}

export function useCommentPins(
  bridge: DesignBridge,
  open: readonly DesignComment[],
  update: (id: string, patch: CommentPatch) => Promise<DesignComment>,
): CommentPins {
  const [rects, setRects] = useState<ReadonlyMap<string, PinRect>>(new Map());
  const [refused, setRefused] = useState<ReadonlySet<string>>(new Set());
  const [moved, setMoved] = useState<ReadonlySet<string>>(new Set());
  const proposed = useRef(new Set<string>());
  const updateRef = useRef(update);
  updateRef.current = update;

  const { send } = bridge;
  const pageFile = bridge.ready?.file ?? null;
  const pins = useMemo(
    () => open.filter((c) => c.file === pageFile).map((c) => ({ id: c.id, anchor: c.anchor })),
    [open, pageFile],
  );
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => { send({ type: "pins-set", pins }); }, [send, pins]);

  useEffect(() => {
    const offs = [
      bridge.onReplay((replaySend, ready) => {
        proposed.current.clear();
        setRefused(new Set());
        setRects(new Map());
        const onPage = openRef.current.filter((c) => c.file === ready.file);
        replaySend({ type: "pins-set", pins: onPage.map((c) => ({ id: c.id, anchor: c.anchor })) });
      }),
      bridge.on("pins-rects", (m) => {
        setRects(new Map(m.pins.map((p) => [p.id, p])));
        for (const p of m.pins) {
          if (!p.reanchored || p.ppmId === null || !p.gen) continue;
          const key = `${p.id}:${p.ppmId}:${p.gen}`;
          if (proposed.current.has(key)) continue;
          proposed.current.add(key);
          updateRef.current(p.id, { anchor: { ppmId: p.ppmId, gen: p.gen } })
            .then(() => setMoved((s) => new Set(s).add(p.id)))
            .catch(() => setRefused((s) => new Set(s).add(p.id)));
        }
      }),
    ];
    return () => { for (const off of offs) off(); };
  }, [bridge.on, bridge.onReplay]); // eslint-disable-line react-hooks/exhaustive-deps

  return useMemo(() => ({
    rects,
    statusOf: (id: string): PinStatus => {
      if (pageFile !== null && !pins.some((p) => p.id === id)) return "elsewhere";
      if (refused.has(id)) return "detached";
      const r = rects.get(id);
      if (!r) return "pending";
      if (!r.rect) return "detached";
      return moved.has(id) || r.reanchored ? "moved" : "pinned";
    },
  }), [rects, refused, moved, pins, pageFile]);
}
