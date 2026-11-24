/**
 * `/ws/web-browser`: one socket per viewer. The upgrade is already behind the PPM token and
 * `checkWebBrowserAccess`; the socket is still not trusted until its first message presents a
 * nonce from `POST /api/web-browser/session`, as Remote Desktop's is. Every later message goes
 * through the protocol parser before it reaches the hub.
 */
import { randomUUIDv7 } from "bun";
import { parseWebBrowserClientMessage } from "../../shared/web-browser-protocol-parse.ts";
import { consumeWebBrowserNonce } from "../../services/web-browser/web-browser-access.ts";
import { viewerHub, type Viewer } from "../../services/web-browser/viewer-hub.ts";
import { webBrowserHost } from "../../services/web-browser/browser-host.ts";
import { createLogger } from "../../services/logger.ts";

const log = createLogger("web-browser");

interface BrowserWs {
  data: { type: "web-browser"; viewer?: Viewer; authenticated?: boolean };
  send(data: string | Uint8Array): number;
  close(code?: number, reason?: string): void;
}

const AUTH_DEADLINE_MS = 10_000;

export const webBrowserWebSocket = {
  open(ws: BrowserWs): void {
    setTimeout(() => {
      if (!ws.data.authenticated) ws.close(1008, "expected auth message");
    }, AUTH_DEADLINE_MS);
  },

  async message(ws: BrowserWs, raw: string | Buffer): Promise<void> {
    if (typeof raw !== "string") return; // viewers send only JSON text
    const msg = parseWebBrowserClientMessage(raw);
    if (!ws.data.authenticated) {
      if (msg?.type !== "auth" || !consumeWebBrowserNonce(msg.nonce)) {
        log.warn("auth rejected: invalid or expired nonce");
        ws.close(1008, "invalid or expired session nonce");
        return;
      }
      ws.data.authenticated = true;
      const viewer: Viewer = {
        id: randomUUIDv7(),
        send: (m) => { ws.send(JSON.stringify(m)); },
        sendBinary: (b) => { ws.send(b); },
      };
      ws.data.viewer = viewer;
      viewerHub.add(viewer);
      // The viewer asked for the browser by opening it: start it if it is not running.
      webBrowserHost.ensureStarted().catch((error) => {
        viewer.send({ type: "error", code: (error as { code?: string })?.code ?? "start-failed", message: String((error as Error)?.message ?? error) });
      });
      return;
    }
    if (!msg || !ws.data.viewer) return;
    await viewerHub.onMessage(ws.data.viewer, msg);
  },

  close(ws: BrowserWs): void {
    if (ws.data.viewer) viewerHub.remove(ws.data.viewer.id);
  },
};
