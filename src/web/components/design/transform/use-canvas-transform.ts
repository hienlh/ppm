import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { toast } from "sonner";
import { postDesignStyle } from "@/lib/design/api-design-edits";
import { decideTransformProposal, readUserActivation } from "@/lib/design/design-transform-proposal";
import type { ChildMessage } from "../../../../shared/design-bridge-protocol";
import type { BridgeRect } from "../../../../shared/design-bridge-messages-picker";
import type { TransformBox } from "../../../../shared/design-bridge-messages-transform";
import type { DesignTabContextValue } from "../design-tab-context";
import type { DesignBridge } from "../canvas/use-design-bridge";
import type { ElementPicker } from "../comments/use-element-picker";
import { pushDesignUndo } from "./design-undo-stack";

/**
 * Move mode for one design tab: which element has handles, what the frame proposes, and
 * which proposals become writes.
 *
 * The target is the element the picker selected, remembered here rather than read from the
 * picker: a write reloads the canvas, the picker drops its selection on every new document,
 * but the patched element keeps its start offset and so its id. Each `ready` replays Move
 * mode and the target, which is what puts the handles back after the reload. A proposal is
 * only written after `decideTransformProposal` says so; anything else is answered with
 * `transform-cancel`, which puts the frame's live style back.
 */

type Commit = Extract<ChildMessage, { type: "transform-commit" }>;
interface Target { ppmId: number; tag: string; file: string }
const ARROWS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

export function useCanvasTransform(tab: DesignTabContextValue, bridge: DesignBridge, picker: ElementPicker, scale: number, reloadCanvas: () => void) {
  const { projectName, slug, tabId, isStreaming } = tab;
  const { send, ready } = bridge;
  const [moveOn, setMoveOn] = useState(false);
  const [target, setTargetState] = useState<Target | null>(null);
  const [live, setLive] = useState<{ rect: BridgeRect | null; box: TransformBox | null } | null>(null);
  const [confirm, setConfirm] = useState<Commit | null>(null);
  const [saving, setSaving] = useState(false);
  const state = useRef({ moveOn, target, ready, isStreaming, scale });
  state.current = { moveOn, target, ready, isStreaming, scale };
  const lastGesture = useRef<number | null>(null);
  const lastRefusalToast = useRef(0);
  const reloaded = useRef(false);
  // The gen our own last write produced, for proposals made before the canvas reloaded.
  const ownWrite = useRef<{ from: string; to: string } | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());

  const setTarget = useCallback((next: Target | null) => {
    setTargetState(next);
    setLive(null);
    send(next ? { type: "transform-target", ppmId: next.ppmId, tag: next.tag } : { type: "transform-target", ppmId: null, tag: "" });
  }, [send]);

  const disabled = isStreaming || !ready || !ready.instrumented;

  const setMove = useCallback((on: boolean) => {
    setMoveOn(on);
    setConfirm(null);
    send({ type: "transform-mode", on, scale: state.current.scale });
    if (!on) { setTarget(null); return; }
    if (!picker.on) picker.setOn(true);
    const sel = picker.selected;
    setTarget(sel && sel.ppmId !== null && sel.file === state.current.ready?.file ? { ppmId: sel.ppmId, tag: sel.tag, file: sel.file } : null);
  }, [send, picker, setTarget]);

  // Writes are off while the design's turn runs, and an uninstrumented file has no ids. A
  // reload (no `ready` for a moment) is not a reason: the next `ready` replays Move mode.
  const mustStop = isStreaming || ready?.instrumented === false;
  useEffect(() => { if (moveOn && mustStop) setMove(false); }, [moveOn, mustStop, setMove]);
  useEffect(() => { if (state.current.moveOn) send({ type: "transform-mode", on: true, scale }); }, [scale, send]);

  // Follow the picker; a selection that vanished because the document reloaded is kept.
  useEffect(() => {
    const sel = picker.selected;
    if (sel) reloaded.current = false;
    if (!state.current.moveOn) return;
    if (sel) setTarget(sel.ppmId === null ? null : { ppmId: sel.ppmId, tag: sel.tag, file: sel.file });
    else if (!reloaded.current) setTarget(null);
  }, [picker.selected, setTarget]);

  const commit = useCallback((m: Commit) => {
    queue.current = queue.current.then(async () => {
      const own = ownWrite.current;
      const gen = own && own.from === m.gen ? own.to : m.gen;
      setSaving(true);
      try {
        const out = await postDesignStyle(projectName, slug, { file: m.file, gen, ppmId: m.ppmId, tag: m.tag, props: m.props });
        if (out.status === "written") {
          ownWrite.current = { from: m.gen, to: out.gen };
          if (out.undoId) pushDesignUndo(tabId, out.undoId);
          return;
        }
        send({ type: "transform-cancel" });
        toast.warning(out.status === "rate-limited" ? out.message : "The design changed; the canvas is reloading", {
          description: out.status === "element-moved" ? out.message : undefined,
        });
        if (out.status !== "rate-limited") reloadCanvas();
      } catch (e) {
        send({ type: "transform-cancel" });
        toast.error("Could not save the change", { description: (e as Error).message });
      } finally {
        setSaving(false);
      }
    });
  }, [projectName, slug, tabId, send, reloadCanvas]);

  const decide = useCallback((m: Commit) => {
    const s = state.current;
    return decideTransformProposal(m, {
      moveOn: s.moveOn, streaming: s.isStreaming, target: s.target, ready: s.ready,
      activation: readUserActivation(typeof navigator === "undefined" ? null : navigator),
      lastParentGestureAt: lastGesture.current, now: Date.now(),
    });
  }, []);

  useEffect(() => {
    const offs = [
      bridge.on("transform-live", (m) => {
        const t = state.current.target;
        if (state.current.moveOn && t && m.ppmId === t.ppmId) setLive({ rect: m.rect, box: m.box });
      }),
      bridge.on("transform-commit", (m) => {
        const verdict = decide(m);
        if (verdict.kind === "write") commit(m);
        else if (verdict.kind === "confirm") setConfirm(m);
        else {
          send({ type: "transform-cancel" });
          // Throttled: the page's own scripts can post proposals, and must not be able to flood toasts.
          if (verdict.reason === "no-gesture" && Date.now() - lastRefusalToast.current > 5000) {
            lastRefusalToast.current = Date.now();
            toast.info("Not saved: the change did not follow a click or key press here");
          }
        }
      }),
      bridge.onReplay((replaySend, next) => {
        reloaded.current = true;
        ownWrite.current = null;
        setLive(null);
        setConfirm(null);
        const s = state.current;
        if (!s.moveOn) return;
        replaySend({ type: "transform-mode", on: true, scale: s.scale });
        if (s.target && s.target.file === next.file) replaySend({ type: "transform-target", ppmId: s.target.ppmId, tag: s.target.tag });
      }),
    ];
    return () => { for (const off of offs) off(); };
  }, [bridge.on, bridge.onReplay, decide, commit, send]); // eslint-disable-line react-hooks/exhaustive-deps

  const markGesture = useCallback(() => { lastGesture.current = Date.now(); }, []);

  /** Arrow keys in the focused canvas pane: forwarded to the frame, which coalesces them. */
  const onPaneKeyDown = useCallback((e: KeyboardEvent) => {
    const step = ARROWS[e.key];
    if (!step || !state.current.moveOn || !state.current.target) return;
    e.preventDefault();
    markGesture();
    const n = e.shiftKey ? 10 : 1;
    send({ type: "transform-nudge", dx: step[0] * n, dy: step[1] * n });
  }, [send, markGesture]);

  const confirmSave = useCallback(() => {
    const m = confirm;
    setConfirm(null);
    markGesture();
    if (m && decide(m).kind === "write") commit(m);
    else if (m) send({ type: "transform-cancel" });
  }, [confirm, markGesture, decide, commit, send]);

  const discard = useCallback(() => {
    setConfirm(null);
    send({ type: "transform-cancel" });
  }, [send]);

  return {
    moveOn, disabled, target, live, confirm: confirm !== null, saving,
    toggle: () => setMove(!moveOn), stop: () => setMove(false),
    confirmSave, discard, markGesture, onPaneKeyDown,
    /** Shown on the selected element's bar when it cannot be moved at all. */
    hint: moveOn && picker.selected?.ppmId === null ? "Created by a script, so it cannot be moved" : null,
  };
}

export type CanvasTransformFeature = ReturnType<typeof useCanvasTransform>;
