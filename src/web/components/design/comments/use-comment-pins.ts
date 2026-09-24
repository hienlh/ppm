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
 * recognise. Each proposal is made once per comment per load — keyed on the comment id
 * alone, not on what the frame claims to have found — so a page varying its answers cannot
 * turn one comment into an unbounded stream of PATCHes, each of which takes the design lock
 * and re-parses the source file.
 *
 * Only comments on the page the frame is showing are sent: a multi-page design's other
 * pages would otherwise be matched by text against this one. The same list is what a
 * proposal is checked against, so an id the frame invents outright is dropped too.
 */

/** `elsewhere`: the comment is on another page of the design than the one on screen. */
export type PinStatus = "pinned" | "moved" | "detached" | "pending" | "elsewhere";

export interface CommentPins {
  rects: ReadonlyMap<string, PinRect>;
  statusOf: (id: string) => PinStatus;
}

interface ReanchoredPin { id: string; ppmId: number | null; gen: string | null; reanchored?: boolean }
export interface ReanchorProposal { id: string; ppmId: number; gen: string }

/**
 * The re-anchor proposals worth acting on from one `pins-rects` reply: at most one per
 * comment id, and only for ids this load actually asked the frame to pin. `proposed` is the
 * caller's per-load dedupe set, mutated in place so a later call for the same load sees what
 * an earlier one already accepted.
 */
export function pickReanchorProposals(
  pins: readonly ReanchoredPin[],
  validIds: ReadonlySet<string>,
  proposed: Set<string>,
): ReanchorProposal[] {
  const out: ReanchorProposal[] = [];
  for (const p of pins) {
    if (!p.reanchored || p.ppmId === null || !p.gen) continue;
    if (!validIds.has(p.id) || proposed.has(p.id)) continue;
    proposed.add(p.id);
    out.push({ id: p.id, ppmId: p.ppmId, gen: p.gen });
  }
  return out;
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
  // Read inside the "pins-rects" handler below instead of `pins` directly: that handler is
  // registered in an effect that does not re-run on every render, so closing over `pins`
  // there would see whichever page was current the last time the effect ran.
  const pinsRef = useRef(pins);
  pinsRef.current = pins;

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
        const validIds = new Set(pinsRef.current.map((p) => p.id));
        for (const proposal of pickReanchorProposals(m.pins, validIds, proposed.current)) {
          updateRef.current(proposal.id, { anchor: { ppmId: proposal.ppmId, gen: proposal.gen } })
            .then(() => setMoved((s) => new Set(s).add(proposal.id)))
            .catch(() => setRefused((s) => new Set(s).add(proposal.id)));
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
