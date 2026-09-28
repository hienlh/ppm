import type { BridgeApi } from "./bridge-core.ts";

/**
 * Keeps the design frame from navigating itself away.
 *
 * The sandbox stops top-level navigation, popups and form posts (`form-action 'none'`), but
 * a sandboxed frame may still navigate *itself*: a link, or `location.href = "https://…"`.
 * That both leaks data in the URL and replaces the design with a foreign page that then
 * owns the iframe's `contentWindow`. So:
 *  - a capture-phase `click`/`auxclick` on any link that would leave the current document
 *    is cancelled and reported as `navigate-blocked`; in-page `#anchor` links still work;
 *  - where the Navigation API exists, a cancelable cross-document `navigate` is cancelled
 *    too, which covers script-driven navigation. A reload of the same URL is allowed.
 * Elsewhere, a script-driven navigation still gets through; the parent notices within 3 s
 * because no `ready` with the current nonce arrives, and reloads the canvas.
 *
 * Shipped as source like the core, so it may only use what it is handed in `ppm`.
 */
export function installNavGuard(ppm: BridgeApi): void {
  const win = ppm.win;
  const doc = ppm.doc;
  const withoutHash = (href: string): string => href.split("#")[0]!;

  function report(href: string): void {
    // `javascript:` links are a common "button that looks like a link"; nothing leaves the
    // document, so there is nothing worth reporting.
    if (!/^javascript:/i.test(href)) ppm.post("navigate-blocked", { href: String(href).slice(0, 2048) });
  }

  function onLinkActivation(event: MouseEvent): void {
    const target = event.target as Element | null;
    if (!target || typeof target.closest !== "function") return;
    const link = target.closest("a[href], area[href]");
    if (!link) return;
    const raw = link.getAttribute("href") || "";
    let url: URL;
    try {
      url = new URL(raw, doc.baseURI);
    } catch (e) {
      event.preventDefault();
      return;
    }
    if (url.hash && withoutHash(url.href) === withoutHash(win.location.href)) return;
    event.preventDefault();
    report(url.protocol === "javascript:" ? raw : url.href);
  }

  win.addEventListener("click", onLinkActivation, true);
  win.addEventListener("auxclick", onLinkActivation, true);

  const navigation = (win as unknown as { navigation?: EventTarget }).navigation;
  if (navigation && typeof navigation.addEventListener === "function") {
    navigation.addEventListener("navigate", (event: Event) => {
      const e = event as Event & { hashChange?: boolean; destination?: { url: string; sameDocument: boolean } };
      if (!e.cancelable || e.hashChange || !e.destination || e.destination.sameDocument) return;
      if (e.destination.url === win.location.href) return;
      e.preventDefault();
      report(e.destination.url);
    });
  }
}
