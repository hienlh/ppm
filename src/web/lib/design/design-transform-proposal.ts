/**
 * Whether a move/resize the canvas proposes is written — decided by the parent, from its
 * own state, never by the frame.
 *
 * The frame runs the page's own scripts, and they can post a `transform-commit` of their
 * own at any time. So a proposal is written only when every one of these holds:
 * - Move mode is on (toggled here, in the parent) and the design's chat is not streaming;
 * - it names the element the parent selected, in the file and gen the parent's `ready` saw;
 * - a real user gesture just happened: `navigator.userActivation.isActive`, which a click or
 *   key press inside the frame sets on its ancestors too and no script can fake. A browser
 *   without that API gets the weaker check of a gesture the parent saw itself (a key in the
 *   canvas pane, a tap on the readout) in the last 5 s, and otherwise the readout asks.
 *
 * What gets past this is still capped by the server's rate limit and is undoable.
 */

export const PARENT_GESTURE_WINDOW_MS = 5000;

export interface TransformProposal {
  ppmId: number;
  tag: string;
  file: string;
  gen: string;
}

export interface ProposalContext {
  moveOn: boolean;
  streaming: boolean;
  target: { ppmId: number; tag: string; file: string } | null;
  ready: { gen: string; file: string } | null;
  /** `navigator.userActivation.isActive`, or null where the browser has no such API. */
  activation: boolean | null;
  lastParentGestureAt: number | null;
  now: number;
}

export type ProposalRejection = "mode-off" | "streaming" | "wrong-target" | "stale-frame" | "no-gesture";

export type ProposalDecision =
  | { kind: "write" }
  | { kind: "confirm" }
  | { kind: "reject"; reason: ProposalRejection };

export function decideTransformProposal(p: TransformProposal, ctx: ProposalContext): ProposalDecision {
  const reject = (reason: ProposalRejection): ProposalDecision => ({ kind: "reject", reason });
  if (!ctx.moveOn) return reject("mode-off");
  if (ctx.streaming) return reject("streaming");
  const t = ctx.target;
  if (!t || p.ppmId !== t.ppmId || p.tag !== t.tag || p.file !== t.file) return reject("wrong-target");
  if (!ctx.ready || p.file !== ctx.ready.file || p.gen !== ctx.ready.gen) return reject("stale-frame");
  if (ctx.activation === true) return { kind: "write" };
  if (ctx.activation === false) return reject("no-gesture");
  const last = ctx.lastParentGestureAt;
  if (last !== null && ctx.now - last >= 0 && ctx.now - last <= PARENT_GESTURE_WINDOW_MS) return { kind: "write" };
  return { kind: "confirm" };
}

/** The browser's transient user activation, or null where it cannot say. */
export function readUserActivation(nav: unknown): boolean | null {
  const ua = (nav as { userActivation?: { isActive?: unknown } } | null | undefined)?.userActivation;
  return ua && typeof ua.isActive === "boolean" ? ua.isActive : null;
}
