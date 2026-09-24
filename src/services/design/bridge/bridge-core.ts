/**
 * The bridge's core, running inside the sandboxed design document.
 *
 * This function is shipped to the frame as source (`toString()`, see bridge-script.ts), so
 * it may not reference anything in this module's scope: every constant is written inline,
 * and the window it runs in is passed in rather than read from a global. It is the first
 * script in `<head>`, so every listener here is registered before the page's own.
 *
 * What it gives the feature modules (`ppm`): `post` (to the parent, nonce attached), `on`
 * (handlers for parent messages, which are only ever accepted from `window.parent`), `byId`
 * (the element carrying a `data-ppm-id`), and `issue` (errors, failed loads and CSP
 * violations, at most 20 per load). It posts `ready` once the document is parsed and
 * `scroll` as the page scrolls, and applies `restore-scroll`.
 */

import type { anchorOf, cssPathOf, describeElement, domTreeAccess, elementQuote } from "./bridge-element-info.ts";
import type { diceSimilarity, resolveAnchor } from "./bridge-anchor-resolve.ts";
import type { createPickerOverlay } from "./bridge-picker-overlay.ts";
import type { applyDrag, formatPx, parseTranslate, zoneAt } from "./bridge-transform-math.ts";
import type { createTransformOverlay } from "./bridge-transform-overlay.ts";
import type { createTransformStyle } from "./bridge-transform-style.ts";

export interface BridgeBoot {
  nonce: string | null;
  gen: string;
  cssGens: Record<string, string>;
  file: string;
  instrumented: boolean;
}

export type BridgeHandler = (message: Record<string, unknown>) => void;

/**
 * Helpers several features share, installed by the assembly as `ppm.lib` from their own
 * source. Keyed by string names the assembly writes, so a bundler renaming the functions
 * cannot break a feature that calls one.
 */
export interface BridgeLib {
  elementQuote: typeof elementQuote;
  domTreeAccess: typeof domTreeAccess;
  cssPathOf: typeof cssPathOf;
  anchorOf: typeof anchorOf;
  describeElement: typeof describeElement;
  diceSimilarity: typeof diceSimilarity;
  resolveAnchor: typeof resolveAnchor;
  createPickerOverlay: typeof createPickerOverlay;
  parseTranslate: typeof parseTranslate;
  formatPx: typeof formatPx;
  applyDrag: typeof applyDrag;
  zoneAt: typeof zoneAt;
  createTransformOverlay: typeof createTransformOverlay;
  createTransformStyle: typeof createTransformStyle;
}

export interface BridgeApi {
  win: Window;
  doc: Document;
  boot: BridgeBoot;
  lib: BridgeLib;
  post(type: string, payload?: Record<string, unknown>): void;
  on(type: string, handler: BridgeHandler): void;
  byId(ppmId: unknown): Element | null;
  issue(kind: "error" | "rejection" | "resource" | "csp", message: string, source?: string, line?: number): void;
  /** Called by the assembly once every feature is installed; schedules `ready`. */
  start(): void;
}

export function installBridgeCore(win: Window): BridgeApi {
  const doc = win.document;
  const script = (doc.currentScript || doc.querySelector("script[data-ppm-bridge]")) as HTMLScriptElement | null;
  const data: DOMStringMap = script ? script.dataset : {};
  let cssGens: Record<string, string> = {};
  try {
    const parsed = JSON.parse(data.cssGens || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) cssGens = parsed;
  } catch (e) {
    cssGens = {};
  }
  const nonce = data.nonce && /^[A-Za-z0-9_-]{16,64}$/.test(data.nonce) ? data.nonce : null;
  const boot: BridgeBoot = {
    nonce, gen: data.gen || "", cssGens, file: data.file || "", instrumented: data.instrumented === "1",
  };
  // Out of the DOM once read, so the page's own markup (and anything describing it) never
  // includes the bridge.
  if (script && script.parentNode) script.parentNode.removeChild(script);

  const parent = win.parent;
  const handlers = new Map<string, BridgeHandler[]>();
  let issues = 0;

  function post(type: string, payload?: Record<string, unknown>): void {
    // Envelope fields are assigned last, so a payload cannot overwrite the nonce or type.
    const message = Object.assign({}, payload || {}, { ppm: "design-bridge", v: 1, nonce, type });
    try {
      parent.postMessage(message, "*");
    } catch (e) {
      // An uncloneable payload is the feature's bug; the page must keep working.
    }
  }

  function issue(kind: "error" | "rejection" | "resource" | "csp", message: string, source?: string, line?: number): void {
    if (issues >= 20) return;
    issues++;
    post("issue", { kind, message: String(message).slice(0, 500), source: source ? String(source).slice(0, 1024) : undefined, line });
  }

  win.addEventListener("message", (event: MessageEvent) => {
    if (parent === win || event.source !== parent) return;
    const m = event.data;
    if (!m || typeof m !== "object" || m.ppm !== "design-bridge" || m.v !== 1 || typeof m.type !== "string") return;
    if (m.nonce !== nonce) return;
    const list = handlers.get(m.type);
    if (!list) return;
    for (let i = 0; i < list.length; i++) {
      try {
        list[i]!(m);
      } catch (e) {
        issue("error", "bridge handler " + m.type + ": " + (e && (e as Error).message));
      }
    }
  });

  win.addEventListener("error", (event: Event) => {
    const target = event.target as (Element & { src?: string; href?: string }) | null;
    if (target && target !== (win as unknown) && target.tagName) {
      issue("resource", "Failed to load <" + target.tagName.toLowerCase() + ">", target.src || target.href || "");
      return;
    }
    const e = event as ErrorEvent;
    issue("error", e.message || "Script error", e.filename, e.lineno);
  }, true);
  win.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    issue("rejection", reason && reason.message ? reason.message : String(reason));
  });
  doc.addEventListener("securitypolicyviolation", (event: SecurityPolicyViolationEvent) => {
    issue("csp", event.violatedDirective + " blocked " + (event.blockedURI || "inline"), event.sourceFile, event.lineNumber);
  });

  let scrollTimer: number | null = null;
  win.addEventListener("scroll", () => {
    if (scrollTimer !== null) return;
    scrollTimer = win.setTimeout(() => {
      scrollTimer = null;
      post("scroll", { x: win.scrollX, y: win.scrollY });
    }, 100);
  }, { passive: true });

  const ppm: BridgeApi = {
    win,
    doc,
    boot,
    // Filled in by the assembly before any feature runs.
    lib: {} as BridgeLib,
    post,
    issue,
    on(type: string, handler: BridgeHandler): void {
      const list = handlers.get(type) || [];
      list.push(handler);
      handlers.set(type, list);
    },
    byId(ppmId: unknown): Element | null {
      if (typeof ppmId !== "number" || !Number.isInteger(ppmId) || ppmId < 0) return null;
      return doc.querySelector('[data-ppm-id="' + ppmId + '"]');
    },
    start(): void {
      const ready = (): void => {
        post("ready", {
          gen: boot.gen,
          cssGens: boot.cssGens,
          file: boot.file,
          instrumented: boot.instrumented,
          title: String(doc.title || "").slice(0, 200),
          docHeight: doc.documentElement ? doc.documentElement.scrollHeight : 0,
        });
      };
      if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", ready, { once: true });
      else ready();
    },
  };

  ppm.on("restore-scroll", (m) => {
    const x = m.x, y = m.y;
    if (typeof x === "number" && typeof y === "number" && isFinite(x) && isFinite(y)) win.scrollTo(x, y);
  });
  return ppm;
}
