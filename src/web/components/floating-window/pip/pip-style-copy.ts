/**
 * Style/theme bootstrap for a PiP document.
 *
 * A PiP window is a separate document: it inherits no stylesheet and no theme.
 * Copying `styleSheets` alone still yields an unthemed window, because the
 * theme is written as inline CSS custom properties on `<html>` — the class and
 * the inline `cssText` must both be mirrored, and re-mirrored on every theme
 * change.
 */

import { THEME_CHANGE_EVENT } from "@/theme/apply-theme";

const STYLE_NODE_SELECTOR = 'style, link[rel="stylesheet"]';

/** Body/slot layout for the PiP document — the slot is the only child. */
const PIP_BASE_CSS = `html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden}
body>*{position:relative;width:100%;height:100%}`;

/** Minimal document shape needed to enumerate style nodes (keeps this pure). */
export interface StyleNodeSource {
  querySelectorAll(selectors: string): ArrayLike<Element>;
}

/** Ordered list of the `<style>` / `<link rel=stylesheet>` nodes to mirror. */
export function collectStyleNodes(doc: StyleNodeSource): Element[] {
  return Array.from(doc.querySelectorAll(STYLE_NODE_SELECTOR));
}

/**
 * Mirror one style node into `dst`. Same-origin sheets are inlined from their
 * parsed rules (no refetch); a cross-origin sheet throws on `cssRules`, so the
 * `<link>` is cloned and the PiP window fetches it itself.
 */
function mirrorStyleNode(node: Element, dst: Document): void {
  const sheet = (node as HTMLStyleElement | HTMLLinkElement).sheet;
  try {
    const rules = sheet?.cssRules;
    if (rules && rules.length > 0) {
      const style = dst.createElement("style");
      style.textContent = Array.from(rules, (rule) => rule.cssText).join("\n");
      dst.head.append(style);
      return;
    }
  } catch {
    // Cross-origin sheet — fall through to cloning the element.
  }
  dst.head.append(node.cloneNode(true));
}

/** Copy every stylesheet of `src` into `dst`, plus the PiP base layout. */
export function copyDocumentStyles(src: Document, dst: Document): void {
  try {
    // Constructed sheets are per-document; adopting a foreign one can throw.
    dst.adoptedStyleSheets = [...src.adoptedStyleSheets];
  } catch {
    // Ignore — the cloned nodes below still carry the app's CSS.
  }
  for (const node of collectStyleNodes(src)) mirrorStyleNode(node, dst);
  const base = dst.createElement("style");
  base.textContent = PIP_BASE_CSS;
  dst.head.append(base);
}

/**
 * Copy `<html>` class + inline theme vars and `<body>` class + inline style, once.
 * The page background is an inline `background: var(--bg)` on `<body>` (index.html),
 * not a class — without it the PiP body stays browser-default white and every
 * transparent region of the moved tab shows through as light.
 */
function copyThemeOnce(src: Document, dst: Document): void {
  dst.documentElement.className = src.documentElement.className;
  dst.documentElement.style.cssText = src.documentElement.style.cssText;
  dst.body.className = src.body.className;
  dst.body.style.cssText = src.body.style.cssText;
}

/**
 * Mirror the theme now and on every theme change. Returns a disposer that
 * unsubscribes.
 */
export function syncThemeToPip(src: Document, dst: Document): () => void {
  copyThemeOnce(src, dst);
  const view = src.defaultView;
  if (!view) return () => {};
  const onThemeChange = () => copyThemeOnce(src, dst);
  view.addEventListener(THEME_CHANGE_EVENT, onThemeChange);
  return () => view.removeEventListener(THEME_CHANGE_EVENT, onThemeChange);
}

/**
 * Mirror stylesheets injected into `src.head` after the copy — Vite dev/HMR
 * appends a new `<style>` on every edit, which the PiP copy would otherwise
 * never see. Harmless in production. Returns a disposer.
 */
export function watchStyleInjection(src: Document, dst: Document): () => void {
  if (typeof MutationObserver === "undefined") return () => {};
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const added of record.addedNodes) {
        if (added instanceof Element && added.matches(STYLE_NODE_SELECTOR)) {
          dst.head.append(added.cloneNode(true));
        }
      }
    }
  });
  observer.observe(src.head, { childList: true });
  return () => observer.disconnect();
}
