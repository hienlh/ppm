import type { BridgeApi } from "./bridge-core.ts";
import type { CommentAnchor } from "../../../shared/design-comment-types.ts";

/**
 * Where each pinned comment's element is, reported to the parent as `pins-rects`.
 *
 * The parent sends the open comments' anchors (`pins-set`); each is resolved here, against
 * the document as it actually is — by id while the gen still matches, otherwise by text
 * quote (`ppm.lib.resolveAnchor`). A pin found by quote under the current gen is reported
 * with its new id and `reanchored: true`, which the parent turns into a request the server
 * re-checks against the source; nothing is written from here.
 *
 * Rects are the elements' viewport boxes, re-sent (rAF-throttled, and only when something
 * moved) on scroll, resize, element resize and DOM mutation. A mutation also re-resolves,
 * after a short debounce, the pins whose element is gone or was never found — a page that
 * renders its content from a script only has the element some time after `ready`.
 *
 * Shipped as source, so it may only use what it is handed in `ppm`.
 */
export function installPins(ppm: BridgeApi): void {
  const win = ppm.win as Window & typeof globalThis;
  const doc = ppm.doc;
  const MAX_CANDIDATES = 3000;
  const gen = /^[0-9a-f]{16}$/.test(ppm.boot.gen) ? ppm.boot.gen : null;

  interface Found {
    el: Element | null;
    ppmId: number | null;
    gen: string | null;
    reanchored: boolean;
  }
  let pins: Array<{ id: string; anchor: CommentAnchor }> = [];
  let found = new Map<string, Found>();
  let lastSent = "";

  function resolve(onlyMissing: boolean): void {
    const byTag: Record<string, { els: Element[]; infos: ReturnType<typeof ppm.lib.anchorOf>[] }> = {};
    const candidates = (tag: string) => {
      if (byTag[tag]) return byTag[tag]!;
      const list = doc.getElementsByTagName(tag);
      const els: Element[] = [];
      for (let i = 0; i < list.length && els.length < MAX_CANDIDATES; i++) {
        if (list[i]!.localName.toLowerCase() === tag) els.push(list[i]!);
      }
      byTag[tag] = { els, infos: els.map((el) => ppm.lib.anchorOf(el, ppm)) };
      return byTag[tag]!;
    };
    const next = new Map<string, Found>();
    for (const pin of pins) {
      const a = pin.anchor;
      const prev = found.get(pin.id);
      if (onlyMissing && prev && prev.el && prev.el.isConnected) {
        next.set(pin.id, prev);
        continue;
      }
      const direct = a.ppmId !== null && a.gen !== null && a.gen === gen ? ppm.byId(a.ppmId) : null;
      if (direct && direct.localName.toLowerCase() === a.tag) {
        next.set(pin.id, { el: direct, ppmId: a.ppmId, gen: a.gen, reanchored: false });
        continue;
      }
      const c = candidates(a.tag);
      const r = ppm.lib.resolveAnchor(a, c.infos, gen, ppm.lib.diceSimilarity);
      if (r.status === "orphaned") {
        next.set(pin.id, { el: null, ppmId: a.ppmId, gen: a.gen, reanchored: false });
        continue;
      }
      const info = c.infos[r.index]!;
      // Only an element with an id, under a known gen, is something the server can check.
      const movable = info.ppmId !== null && gen !== null && (info.ppmId !== a.ppmId || gen !== a.gen);
      next.set(pin.id, {
        el: c.els[r.index]!, ppmId: movable ? info.ppmId : a.ppmId, gen: movable ? gen : a.gen, reanchored: movable,
      });
    }
    found = next;
    observeElements();
  }

  function report(): void {
    const out = pins.map((pin) => {
      const f = found.get(pin.id);
      const el = f && f.el && f.el.isConnected ? f.el : null;
      const r = el ? el.getBoundingClientRect() : null;
      return {
        id: pin.id,
        rect: r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null,
        ppmId: f ? f.ppmId : pin.anchor.ppmId,
        gen: f ? f.gen : pin.anchor.gen,
        reanchored: !!(f && f.reanchored),
      };
    });
    const key = JSON.stringify(out);
    if (key === lastSent) return;
    lastSent = key;
    ppm.post("pins-rects", { pins: out });
  }

  let reportQueued = false;
  function reportSoon(): void {
    if (reportQueued || pins.length === 0) return;
    reportQueued = true;
    const run = (): void => {
      reportQueued = false;
      report();
    };
    if (typeof win.requestAnimationFrame === "function") win.requestAnimationFrame(run);
    else win.setTimeout(run, 16);
  }

  let resolveTimer = 0;
  function resolveMissingSoon(): void {
    let missing = false;
    found.forEach((f) => {
      if (!f.el || !f.el.isConnected) missing = true;
    });
    if (!missing || resolveTimer) return;
    resolveTimer = win.setTimeout(() => {
      resolveTimer = 0;
      resolve(true);
      reportSoon();
    }, 300);
  }

  const resizes = typeof win.ResizeObserver === "function" ? new win.ResizeObserver(reportSoon) : null;
  function observeElements(): void {
    if (!resizes) return;
    resizes.disconnect();
    if (doc.documentElement) resizes.observe(doc.documentElement);
    found.forEach((f) => {
      if (f.el) resizes.observe(f.el);
    });
  }

  if (typeof win.MutationObserver === "function" && doc.documentElement) {
    new win.MutationObserver(() => {
      if (pins.length === 0) return;
      reportSoon();
      resolveMissingSoon();
    }).observe(doc.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
  }
  win.addEventListener("scroll", reportSoon, { capture: true, passive: true });
  win.addEventListener("resize", reportSoon, { passive: true });
  win.addEventListener("load", reportSoon);

  ppm.on("pins-set", (m) => {
    // Validated by the parent before sending; a page script forging this message can only
    // mislead its own frame, so a malformed entry is just dropped.
    const list = Array.isArray(m.pins) ? (m.pins as Array<{ id: string; anchor: CommentAnchor }>).slice(0, 500) : [];
    pins = list.filter((p) => p && typeof p.id === "string" && p.anchor && typeof p.anchor.tag === "string"
      && p.anchor.quote && typeof p.anchor.quote.exact === "string");
    found = new Map();
    // The parent may have forgotten what it was told; always answer a new set.
    lastSent = "";
    resolve(false);
    if (pins.length === 0) ppm.post("pins-rects", { pins: [] });
    else reportSoon();
  });
}
