/** Served from the forward's own origin; no inline-script CSP exception is needed. */
export const PREVIEW_NAVIGATION_PATH = "/__ppm_preview_navigation__.js";

export function previewNavigationScript(origins: readonly string[]): string {
  return `(() => {
    if (parent === window) return;
    const origins = ${JSON.stringify(origins)};
    const report = () => {
      for (const origin of origins) parent.postMessage({ ppm: "web-preview-navigation", url: location.href }, origin);
    };
    for (const name of ["pushState", "replaceState"]) {
      const original = history[name];
      history[name] = function(...args) { const result = original.apply(this, args); report(); return result; };
    }
    addEventListener("popstate", report);
    addEventListener("hashchange", report);
    addEventListener("pageshow", report);
    report();
  })();`;
}

/** Stream the document through the HTML parser, preserving the application's scripts and CSP. */
export function withPreviewNavigation(response: Response, origin: string): Response {
  if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/html")
    || response.status !== 200 || response.headers.has("content-disposition")) return response;
  for (const header of ["content-length", "etag", "last-modified", "content-md5"]) response.headers.delete(header);
  response.headers.set("cache-control", "no-store");
  let inserted = false;
  const script = `<script src="${origin}${PREVIEW_NAVIGATION_PATH}"></script>`;
  const insert = (element: { before(content: string, options: { html: boolean }): void }) => {
    if (inserted) return;
    inserted = true;
    // Absolute URL also works when the app sets a <base> pointing elsewhere.
    element.before(script, { html: true });
  };
  return new HTMLRewriter().on("head", {
    element(element) {
      if (inserted) return;
      inserted = true;
      element.prepend(script, { html: true });
    },
  }).on("body, script", { element: insert }).onDocument({
    end(end) { if (!inserted) end.append(script, { html: true }); },
  }).transform(response);
}
