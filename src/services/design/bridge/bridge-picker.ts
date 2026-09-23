import type { BridgeApi } from "./bridge-core.ts";

/**
 * Element picking inside the design frame, for pinned comments.
 *
 * While the parent has the picker on, the pointer outlines what it is over and a click
 * selects it. On touch a first tap outlines, a second tap on the same element selects,
 * and a 500 ms long-press selects and asks for the comment composer (`element-menu`).
 *
 * The outline is drawn by `ppm.lib.createPickerOverlay` (a closed shadow root that is
 * never an event target), re-created with every document.
 *
 * Picking must not also *use* the page: clicks, presses, drags and selections are swallowed
 * in the capture phase on `window`. The bridge is the first script in `<head>`, and this
 * feature is installed before the nav guard, so these listeners run before anything else.
 *
 * The long-press is disarmed on `touchmove` past 10 px, on `touchend` and on `touchcancel`:
 * once the browser takes the gesture for a scroll it fires `touchcancel` and delivers no
 * further move or end, and a timer left armed would open the composer over a list the
 * finger is already scrolling.
 *
 * Shipped as source, so it may only use what it is handed in `ppm`.
 */
export function installPicker(ppm: BridgeApi): void {
  const win = ppm.win;
  const doc = ppm.doc;
  const LONG_PRESS_MS = 500;
  const MOVE_TOLERANCE = 10;
  // Mouse events a browser synthesises after a tap arrive within this window of the touch.
  const TOUCH_WINDOW_MS = 800;

  let on = false;
  let outlined: Element | null = null;
  let selected: Element | null = null;
  let press: { target: Element; x: number; y: number; timer: number; fired: boolean } | null = null;
  let lastTouchAt = -Infinity;
  let swallowClicksUntil = -Infinity;
  let overlay: ReturnType<typeof ppm.lib.createPickerOverlay> | null = null;

  function draw(): void {
    if (!outlined && !selected && !overlay) return;
    if (!overlay) overlay = ppm.lib.createPickerOverlay(doc);
    overlay.show("outline", on && outlined !== selected ? outlined : null);
    overlay.show("selection", selected);
  }

  let drawQueued = false;
  function redrawSoon(): void {
    if (drawQueued || (!outlined && !selected)) return;
    drawQueued = true;
    const run = (): void => {
      drawQueued = false;
      draw();
      // The parent places its action bar from the selection's rect, so it needs the new one.
      if (selected && selected.isConnected) ppm.post("select", { el: ppm.lib.describeElement(selected, ppm) });
    };
    if (typeof win.requestAnimationFrame === "function") win.requestAnimationFrame(run);
    else win.setTimeout(run, 16);
  }

  function pick(target: EventTarget | null): Element | null {
    const el = target as Element | null;
    if (!el || el.nodeType !== 1 || el === doc.documentElement) return null;
    return overlay && el === overlay.host ? null : el;
  }

  function outline(el: Element | null): void {
    if (el === outlined) return;
    outlined = el;
    draw();
    if (!el) {
      ppm.post("hover", { el: null });
      return;
    }
    const r = el.getBoundingClientRect();
    ppm.post("hover", { el: { tag: el.localName.toLowerCase(), rect: { x: r.left, y: r.top, w: r.width, h: r.height } } });
  }

  function select(el: Element, openComposer: boolean): void {
    selected = el;
    outlined = null;
    draw();
    ppm.post(openComposer ? "element-menu" : "select", { el: ppm.lib.describeElement(el, ppm) });
  }

  function disarm(): void {
    if (press) win.clearTimeout(press.timer);
    press = null;
  }

  function setOn(next: boolean): void {
    on = next;
    if (!on) {
      disarm();
      outlined = null;
      draw();
    }
  }

  const swallow = (event: Event): void => {
    if (!on) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  win.addEventListener("click", (event: MouseEvent) => {
    if (!on) return;
    swallow(event);
    const now = Date.now();
    if (now < swallowClicksUntil) return;
    const el = pick(event.target);
    if (!el) return;
    if (now - lastTouchAt > TOUCH_WINDOW_MS) select(el, false);
    else if (el === outlined) select(el, false);
    else outline(el);
  }, true);
  const swallowed = ["mousedown", "mouseup", "pointerdown", "pointerup", "dblclick", "auxclick", "contextmenu", "submit", "selectstart", "dragstart"];
  for (const type of swallowed) win.addEventListener(type, swallow, true);

  win.addEventListener("mousemove", (event: MouseEvent) => {
    if (!on || Date.now() - lastTouchAt < TOUCH_WINDOW_MS) return;
    outline(pick(event.target));
  }, { capture: true, passive: true });

  win.addEventListener("touchstart", (event: TouchEvent) => {
    if (!on) return;
    lastTouchAt = Date.now();
    disarm();
    const target = pick(event.target);
    const t = event.touches && event.touches[0];
    if (!target || (event.touches && event.touches.length > 1)) return;
    const entry = { target, x: t ? t.clientX : 0, y: t ? t.clientY : 0, timer: 0, fired: false };
    entry.timer = win.setTimeout(() => {
      entry.fired = true;
      select(entry.target, true);
    }, LONG_PRESS_MS);
    press = entry;
  }, { capture: true, passive: true });
  win.addEventListener("touchmove", (event: TouchEvent) => {
    const t = event.touches && event.touches[0];
    if (!press || !t) return;
    if (Math.abs(t.clientX - press.x) > MOVE_TOLERANCE || Math.abs(t.clientY - press.y) > MOVE_TOLERANCE) disarm();
  }, { capture: true, passive: true });
  win.addEventListener("touchend", () => {
    lastTouchAt = Date.now();
    // The click that follows a completed long-press is not a tap.
    if (press && press.fired) swallowClicksUntil = lastTouchAt + TOUCH_WINDOW_MS;
    disarm();
  }, { capture: true, passive: true });
  win.addEventListener("touchcancel", disarm, { capture: true, passive: true });

  win.addEventListener("keydown", (event: KeyboardEvent) => {
    if (!on || event.key !== "Escape") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    setOn(false);
    ppm.post("picker-exit");
  }, true);

  // Capture, so a scrolling container inside the page moves the outline too.
  win.addEventListener("scroll", redrawSoon, { capture: true, passive: true });
  win.addEventListener("resize", redrawSoon, { passive: true });

  ppm.on("picker", (m) => setOn(m.on === true));
  ppm.on("select-parent", () => {
    const parent = selected && selected.parentElement;
    if (parent && parent !== doc.documentElement) select(parent, false);
  });
  ppm.on("clear-selection", () => {
    selected = null;
    outlined = null;
    draw();
  });
}
