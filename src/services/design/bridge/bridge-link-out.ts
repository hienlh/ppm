import type { BridgeApi } from "./bridge-core.ts";

/**
 * Hands a link that leaves the page to the parent, for the HTML file preview.
 *
 * The preview's iframe is `sandbox="allow-scripts"` with no `allow-popups`, so a
 * `target="_blank"` link or `window.open` does nothing at all, and a plain link to another
 * site replaces the page with one that usually refuses to be framed. Either way a page full
 * of links — a dashboard pointing at Jira, GitHub, or a PPM chat — was dead inside PPM. So a
 * click on an http(s) link that opens a new tab, or goes to another origin, is cancelled
 * here and posted as `open-link`; the parent opens it as a PPM tab or a browser tab. A link
 * to another page of the preview, in the same frame, is left alone and the frame follows it.
 *
 * Bubble phase, and nothing the page already handled: a page that cancels a click to do
 * something of its own with the link keeps doing it.
 *
 * Shipped as source like the core, so it may only use what it is handed in `ppm`.
 */
export function installLinkOut(ppm: BridgeApi): void {
  const win = ppm.win;
  const doc = ppm.doc;

  function onLinkActivation(event: MouseEvent): void {
    if (event.defaultPrevented) return;
    // auxclick also fires for the right button, which opens the context menu, not the link.
    if (event.type === "auxclick" && event.button !== 1) return;
    const target = event.target as Element | null;
    if (!target || typeof target.closest !== "function") return;
    const link = target.closest("a[href], area[href]");
    if (!link) return;
    let url: URL;
    try {
      url = new URL(link.getAttribute("href") || "", doc.baseURI);
    } catch (e) {
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    const frameTarget = (link.getAttribute("target") || "").toLowerCase();
    const newTab = (frameTarget !== "" && frameTarget !== "_self")
      || event.type === "auxclick" || event.ctrlKey || event.metaKey || event.shiftKey;
    if (!newTab && url.origin === win.location.origin) return;
    event.preventDefault();
    ppm.post("open-link", { href: url.href.slice(0, 2048) });
  }

  win.addEventListener("click", onLinkActivation);
  win.addEventListener("auxclick", onLinkActivation);
}
