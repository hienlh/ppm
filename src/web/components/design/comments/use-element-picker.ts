import { useCallback, useEffect, useRef, useState } from "react";
import type { DesignBridge } from "../canvas/use-design-bridge";
import type { BridgeRect, PickedElement } from "../../../../shared/design-bridge-messages-picker";
import type { CommentAnchor } from "../../../../shared/design-comment-types";

/**
 * The parent half of element picking: whether the picker is on, what the frame outlined
 * (a first tap on touch, so the thumb-zone bar can say "tap again"), and what is selected.
 *
 * The frame forgets everything on every new document — a live reload, a token rotation, a
 * panel move — so the picker's on/off state is replayed on each `ready` and the selection
 * is dropped: its element may not exist in the new document at all.
 */

export interface ElementPicker {
  on: boolean;
  outlined: { tag: string; rect: BridgeRect } | null;
  selected: PickedElement | null;
  setOn: (on: boolean) => void;
  selectParent: () => void;
  clear: () => void;
}

export function anchorFromPicked(el: PickedElement): CommentAnchor {
  return { file: el.file, ppmId: el.ppmId, gen: el.gen, tag: el.tag, cssPath: el.cssPath, quote: el.quote };
}

export function useElementPicker(bridge: DesignBridge, onLongPress: (el: PickedElement) => void): ElementPicker {
  const [on, setOnState] = useState(false);
  const [outlined, setOutlined] = useState<ElementPicker["outlined"]>(null);
  const [selected, setSelected] = useState<PickedElement | null>(null);
  const onRef = useRef(false);
  const longPressRef = useRef(onLongPress);
  longPressRef.current = onLongPress;
  const { send } = bridge;

  const clear = useCallback(() => {
    setSelected(null);
    setOutlined(null);
    send({ type: "clear-selection" });
  }, [send]);

  const setOn = useCallback((next: boolean) => {
    onRef.current = next;
    setOnState(next);
    send({ type: "picker", on: next });
    if (!next) clear();
  }, [send, clear]);

  const selectParent = useCallback(() => { send({ type: "select-parent" }); }, [send]);

  useEffect(() => {
    // The page's own scripts can post these too; while the picker is off, nobody is picking,
    // so a stray one must not select anything or pop the composer open.
    const offs = [
      bridge.on("hover", (m) => { if (onRef.current) setOutlined(m.el); }),
      bridge.on("select", (m) => { if (onRef.current) { setSelected(m.el); setOutlined(null); } }),
      bridge.on("element-menu", (m) => {
        if (!onRef.current) return;
        setSelected(m.el);
        setOutlined(null);
        longPressRef.current(m.el);
      }),
      bridge.on("picker-exit", () => setOn(false)),
      bridge.onReplay((replaySend) => {
        setSelected(null);
        setOutlined(null);
        if (onRef.current) replaySend({ type: "picker", on: true });
      }),
    ];
    return () => { for (const off of offs) off(); };
  }, [bridge.on, bridge.onReplay, setOn]); // eslint-disable-line react-hooks/exhaustive-deps

  // Esc exits on the parent side too, where focus usually is on a desktop. A dialog open
  // over the canvas owns its own Esc.
  useEffect(() => {
    if (!on) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || document.querySelector("[role=dialog]")) return;
      setOn(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [on, setOn]);

  return { on, outlined, selected, setOn, selectParent, clear };
}
