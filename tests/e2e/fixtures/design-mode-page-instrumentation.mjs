/**
 * The design-mode e2e's page instrumentation, installed with `context.addInitScript`: it
 * records what the tests assert on but the UI does not show — every bridge message the page
 * receives, `file:changed` paths, History refresh events, chat sockets opened, and the type of
 * every Blob turned into a URL — and points the app's WebSockets at the fixture server.
 *
 * It runs in every document, the sandboxed canvas included, so it may use nothing from here.
 */
export function pageInstrumentation({ api }) {
  const e2e = { bridge: [], fileChanged: [], historyEvents: 0, chatSockets: [], blobTypes: [] };
  window.__e2e = e2e;
  window.addEventListener("message", (event) => {
    const d = event.data;
    if (!d || d.ppm !== "design-bridge") return;
    let data = null;
    try { data = JSON.parse(JSON.stringify(d)); } catch { /* not cloneable to JSON: keep the type only */ }
    e2e.bridge.push({ type: d.type, nonce: d.nonce, gen: d.gen, file: d.file, at: Date.now(), data });
  });
  window.addEventListener("file:changed", (e) => { e2e.fileChanged.push(String(e.detail?.path ?? "")); });
  window.addEventListener("design:history_changed", () => { e2e.historyEvents++; });
  const createObjectURL = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (obj) => { e2e.blobTypes.push(obj && obj.type); return createObjectURL(obj); };
  if (window.top !== window) return;
  try {
    localStorage.setItem("ppm-onboarding-v1", JSON.stringify({
      version: 1, status: "dismissed", familiarity: null, goal: null, currentStep: null, completed: [], skipped: [], projectName: null, sessionId: null,
    }));
  } catch { /* storage unavailable: the tour card may show, which no step depends on */ }
  const NativeSocket = window.WebSocket;
  window.WebSocket = class extends NativeSocket {
    constructor(input, protocols) {
      const url = new URL(String(input), location.href);
      if (url.hostname === "127.0.0.1" && url.port === "8081") url.port = new URL(api).port;
      if (/\/ws\/project\/[^/]+\/chat\//.test(url.pathname)) e2e.chatSockets.push(url.pathname);
      super(url.href, protocols);
    }
  };
}
