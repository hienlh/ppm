import type { BridgeApi } from "./bridge-core.ts";
import type { TransformZone } from "./bridge-transform-math.ts";
import type { SavedInlineStyle, TransformPending } from "./bridge-transform-style.ts";

/**
 * Move and resize inside the design frame.
 *
 * With Move on (`transform-mode`) and a target (`transform-target`, the element the parent
 * selected), the element gets a move area and eight resize handles. A drag restyles it live
 * (inline `translate`/`width`/`height`, normal priority, so what shows is what a write would
 * do) and on release posts `transform-commit` — only a proposal: the parent decides, and
 * answers a refusal with `transform-cancel`, which puts the style back. Arrow keys (Shift for
 * 10 px), here or forwarded as `transform-nudge`, are coalesced into one proposal 500 ms after
 * the last key. `pointercancel` and Esc revert.
 *
 * Installed before the picker, so these capture listeners on `window` run first and every
 * event on the handles stops here, before the picker (which would select the handle host) or
 * the page sees it. Shipped as source, so it may only use `ppm`.
 */
export function installTransform(ppm: BridgeApi): void {
  const win = ppm.win;
  const doc = ppm.doc;
  const lib = ppm.lib;
  const NUDGE_COMMIT_MS = 500;
  const ALL: TransformZone[] = ["move", "nw", "ne", "sw", "se", "n", "s", "w", "e"];
  // Without a px translate to extend, only the handles that leave the offset alone work.
  const SIZE_ONLY: TransformZone[] = ["se", "s", "e"];
  const { measure, save, restore, props, apply } = lib.createTransformStyle(win, lib.formatPx, lib.parseTranslate);

  let on = false;
  let scale = 1;
  let target: { ppmId: number; tag: string } | null = null;
  let overlay: ReturnType<typeof lib.createTransformOverlay> | null = null;
  let drag: (TransformPending & { pointerId: number; zone: TransformZone; x: number; y: number; moved: boolean }) | null = null;
  let nudge: (TransformPending & { timer: number }) | null = null;
  let lastProposal: { ppmId: number; base: SavedInlineStyle } | null = null;
  let tick: number | null = null;

  function element(): HTMLElement | null {
    if (!target) return null;
    const el = ppm.byId(target.ppmId);
    return el && el.localName.toLowerCase() === target.tag ? (el as HTMLElement) : null;
  }
  const rectOf = (el: Element) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };

  let liveQueued = false;
  let lastLive = "";
  /** Where the element is now, at most once a frame and only when it changed. */
  function postLive(): void {
    liveQueued = false;
    const el = element();
    if (!on || !target) return;
    const p = drag || nudge;
    const payload = { ppmId: target.ppmId, rect: el ? rectOf(el) : null, box: p ? p.box : el ? measure(el).box : null };
    const key = JSON.stringify(payload);
    if (key === lastLive) return;
    lastLive = key;
    ppm.post("transform-live", payload);
  }
  function draw(): void {
    const el = on ? element() : null;
    if (el && !overlay) overlay = lib.createTransformOverlay(doc);
    if (overlay) overlay.place(el ? rectOf(el) : null, 44 / scale, scale, el && !measure(el).movable ? SIZE_ONLY : ALL);
    if (liveQueued || !target || !on) return;
    liveQueued = true;
    if (typeof win.requestAnimationFrame === "function") win.requestAnimationFrame(postLive);
    else win.setTimeout(postLive, 16);
  }

  function propose(p: TransformPending): void {
    const changed = props(p.start, p.box);
    if (!target || Object.keys(changed).length === 0) return;
    lastProposal = { ppmId: target.ppmId, base: p.base };
    ppm.post("transform-commit", { file: ppm.boot.file, gen: ppm.boot.gen, ppmId: target.ppmId, tag: target.tag, props: changed });
  }
  function flushNudge(): void {
    const done = nudge;
    nudge = null;
    if (done) { win.clearTimeout(done.timer); propose(done); }
  }
  function revert(): boolean {
    const el = element();
    const p = drag || nudge;
    if (nudge) win.clearTimeout(nudge.timer);
    drag = null;
    nudge = null;
    if (!p) return false;
    if (el) restore(el, p.base);
    draw();
    return true;
  }
  function nudgeBy(dx: number, dy: number): void {
    const el = on && !drag ? element() : null;
    if (!el) return;
    if (!nudge) {
      const m = measure(el);
      if (!m.movable) return;
      nudge = { start: m.box, box: { tx: m.box.tx, ty: m.box.ty, w: m.box.w, h: m.box.h }, base: save(el), timer: 0 };
    }
    nudge.box.tx += dx;
    nudge.box.ty += dy;
    apply(el, nudge);
    win.clearTimeout(nudge.timer);
    nudge.timer = win.setTimeout(flushNudge, NUDGE_COMMIT_MS);
    draw();
  }

  const onHandles = (event: Event): boolean => on && !!overlay && event.target === overlay.host;
  const consume = (event: Event): void => {
    if (event.cancelable) event.preventDefault();
    event.stopImmediatePropagation();
  };
  const listen = (type: string, fn: (event: Event) => void): void => win.addEventListener(type, fn, { capture: true, passive: false });

  listen("pointerdown", (event) => {
    if (!onHandles(event)) return;
    consume(event);
    const e = event as PointerEvent;
    const el = element();
    if (!el || drag || (e.pointerType === "mouse" && e.button !== 0)) return;
    const m = measure(el);
    const zone = lib.zoneAt(rectOf(el), e.clientX, e.clientY, 44 / scale);
    if (!zone || (m.movable ? ALL : SIZE_ONLY).indexOf(zone) < 0) return;
    flushNudge();
    // Consuming mousedown also cancels the focus it would give this frame; arrow keys need it.
    win.focus();
    drag = { start: m.box, box: m.box, base: save(el), pointerId: e.pointerId, zone, x: e.clientX, y: e.clientY, moved: false };
    try { overlay!.host.setPointerCapture(e.pointerId); } catch (err) { /* capture is a nicety; window listeners still see the drag */ }
  });
  /** The drag's own pointer event, consumed; any other event on the handles is consumed too. */
  const ours = (event: Event): PointerEvent | null => {
    const mine = !!drag && (event as PointerEvent).pointerId === drag.pointerId;
    if (mine || onHandles(event)) consume(event);
    return mine ? (event as PointerEvent) : null;
  };
  listen("pointermove", (event) => {
    const e = ours(event);
    const el = element();
    if (!e || !drag || !el) return;
    drag.box = lib.applyDrag(drag.start, drag.zone, e.clientX - drag.x, e.clientY - drag.y);
    drag.moved = true;
    apply(el, drag);
    draw();
  });
  listen("pointerup", (event) => {
    if (!ours(event) || !drag) return;
    const done = drag;
    drag = null;
    if (done.moved) propose(done);
    draw();
  });
  listen("pointercancel", (event) => { if (ours(event)) revert(); });
  // Whatever else lands on the handles is theirs too, so neither the picker nor the page acts on it.
  const swallowed = ["mousedown", "mouseup", "mousemove", "click", "dblclick", "auxclick", "contextmenu",
    "touchstart", "touchmove", "touchend", "touchcancel", "dragstart", "selectstart"];
  for (const type of swallowed) listen(type, (event) => { if (onHandles(event)) consume(event); });

  listen("keydown", (event) => {
    const e = event as KeyboardEvent;
    if (!on || !target) return;
    if (e.key === "Escape") {
      if (revert()) consume(e);
      return;
    }
    const steps: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const step = steps[e.key];
    const t = e.target as HTMLElement | null;
    const editing = !!t && (/^(input|textarea|select)$/i.test(t.tagName || "") || t.isContentEditable === true);
    if (!step || editing || !element()) return;
    consume(e);
    nudgeBy(step[0] * (e.shiftKey ? 10 : 1), step[1] * (e.shiftKey ? 10 : 1));
  });

  const redraw = (): void => { if (on && target) draw(); };
  win.addEventListener("scroll", redraw, { capture: true, passive: true });
  win.addEventListener("resize", redraw, { passive: true });

  ppm.on("transform-mode", (m) => {
    const next = m.on === true;
    if (typeof m.scale === "number" && isFinite(m.scale) && m.scale > 0) scale = m.scale;
    if (!next) revert();
    on = next;
    if (tick !== null) win.clearInterval(tick);
    // Layout can shift under the handles without a scroll or resize (fonts, images, scripts).
    tick = on ? win.setInterval(redraw, 400) : null;
    draw();
  });
  ppm.on("transform-target", (m) => {
    const next = typeof m.ppmId === "number" && typeof m.tag === "string" ? { ppmId: m.ppmId, tag: m.tag } : null;
    if (!next || !target || next.ppmId !== target.ppmId) revert();
    target = next;
    draw();
  });
  ppm.on("transform-nudge", (m) => { if (typeof m.dx === "number" && typeof m.dy === "number" && isFinite(m.dx + m.dy)) nudgeBy(m.dx, m.dy); });
  ppm.on("transform-cancel", () => {
    const el = lastProposal ? ppm.byId(lastProposal.ppmId) : null;
    if (lastProposal && el) restore(el as HTMLElement, lastProposal.base);
    lastProposal = null;
    draw();
  });
}
