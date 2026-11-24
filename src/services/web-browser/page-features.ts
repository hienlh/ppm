/**
 * What pages ask of the viewer — dialogs, file choosers, the clipboard, popups, downloads —
 * wired between Chrome and the viewer hub. Installed once (`installPageFeatures`).
 *
 * Copying reads the selection in an isolated world, so page script cannot fake what lands on
 * the viewer's clipboard. A dialog nobody answers is dismissed after a minute rather than
 * hanging its page. A page never reads the viewer's clipboard: text arrives only when the viewer
 * pastes.
 */
import { randomUUIDv7 } from "bun";
import type { ViewerHub } from "./viewer-hub.ts";
import type { CdpEvent } from "./cdp-connection.ts";
import { trackDownloads } from "./download-manager.ts";
import { uploadPath } from "./upload-store.ts";

const DIALOG_TIMEOUT_MS = 60_000;
const COPY_SCRIPT = `(() => { const a = document.activeElement;
  if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA") && typeof a.selectionStart === "number") return a.value.slice(a.selectionStart, a.selectionEnd);
  return String(getSelection() ?? ""); })()`;

interface PendingDialog { sessionId: string; timer: ReturnType<typeof setTimeout> }
interface PendingChooser { sessionId: string; backendNodeId: number }

export function installPageFeatures(hub: ViewerHub): void {
  const host = hub.host;
  const dialogs = new Map<string, PendingDialog>();
  const choosers = new Map<string, PendingChooser>();
  let offEvents: (() => void) | null = null;
  let offDownloads: (() => void) | null = null;

  host.addPageSetup(async (sessionId) => {
    await host.cdp?.send("Page.setInterceptFileChooserDialog", { enabled: true }, sessionId).catch(() => {});
  });

  const activeSession = () => (host.activeTabId ? host.tabs?.get(host.activeTabId)?.sessionId : undefined);
  const originOf = (sessionId: string) => {
    const tab = host.tabs?.list().find((t) => host.tabs?.get(t.id)?.sessionId === sessionId);
    try { return tab ? new URL(tab.url).origin : ""; } catch { return ""; }
  };

  const onEvent = (e: CdpEvent) => {
    const p = e.params as Record<string, any>;
    if (e.method === "Page.javascriptDialogOpening" && e.sessionId) {
      const id = randomUUIDv7();
      const sessionId = e.sessionId;
      const timer = setTimeout(() => {
        dialogs.delete(id);
        void host.cdp?.send("Page.handleJavaScriptDialog", { accept: false }, sessionId).catch(() => {});
        hub.broadcast({ type: "dialog.closed", id });
      }, DIALOG_TIMEOUT_MS);
      dialogs.set(id, { sessionId, timer });
      const kind = ["alert", "confirm", "prompt", "beforeunload"].includes(p.type) ? p.type : "alert";
      hub.broadcast({ type: "dialog", id, kind, origin: originOf(sessionId), message: String(p.message ?? "").slice(0, 4000), defaultText: String(p.defaultPrompt ?? "") });
    } else if (e.method === "Page.javascriptDialogClosed" && e.sessionId) {
      for (const [id, d] of dialogs) {
        if (d.sessionId !== e.sessionId) continue;
        clearTimeout(d.timer);
        dialogs.delete(id);
        hub.broadcast({ type: "dialog.closed", id });
      }
    } else if (e.method === "Page.fileChooserOpened" && e.sessionId && typeof p.backendNodeId === "number") {
      const chooserId = randomUUIDv7();
      choosers.set(chooserId, { sessionId: e.sessionId, backendNodeId: p.backendNodeId });
      hub.controller?.send({ type: "fileChooser", chooserId, multiple: p.mode === "selectMultiple", accept: "" });
    } else if (e.method === "Target.targetCreated" && p.targetInfo?.type === "page" && p.targetInfo?.openerId) {
      // A link opened in a new tab or a popup: show it, as a browser would.
      const id = String(p.targetInfo.targetId);
      void (async () => {
        for (let i = 0; i < 50 && !host.tabs?.get(id); i++) await Bun.sleep(20);
        if (host.tabs?.get(id)) await hub.activate(id);
      })();
    }
  };

  host.on("state", (state: string) => {
    offEvents?.(); offEvents = null;
    offDownloads?.(); offDownloads = null;
    const cdp = host.cdp;
    if (state !== "running" || !cdp) return;
    offEvents = cdp.onEvent(onEvent);
    void trackDownloads(cdp, (r) => hub.broadcast({ type: "download", ...r })).then((off) => { offDownloads = off; });
  });

  hub.handle("clipboard.paste", async (msg) => {
    const sessionId = activeSession();
    if (msg.type !== "clipboard.paste" || !sessionId) return;
    host.touchInput();
    await host.cdp?.send("Input.insertText", { text: msg.text }, sessionId).catch(() => {});
  });

  hub.handle("clipboard.copyRequest", async (_msg, viewer) => {
    const sessionId = activeSession();
    const cdp = host.cdp;
    if (!sessionId || !cdp || !host.activeTabId) return;
    const world = await cdp.send<{ executionContextId: number }>("Page.createIsolatedWorld", { frameId: host.activeTabId, worldName: "ppm-copy" }, sessionId).catch(() => null);
    if (!world) return;
    const r = await cdp.send<{ result: { value?: unknown } }>("Runtime.evaluate", { expression: COPY_SCRIPT, contextId: world.executionContextId, returnByValue: true }, sessionId).catch(() => null);
    const text = typeof r?.result.value === "string" ? r.result.value.slice(0, 1024 * 1024) : "";
    if (text) viewer.send({ type: "clipboard.copy", text });
  });

  hub.handle("dialog.answer", async (msg) => {
    if (msg.type !== "dialog.answer") return;
    const d = dialogs.get(msg.id);
    if (!d) return;
    clearTimeout(d.timer);
    dialogs.delete(msg.id);
    await host.cdp?.send("Page.handleJavaScriptDialog", { accept: msg.accept, ...(msg.text !== undefined ? { promptText: msg.text } : {}) }, d.sessionId).catch(() => {});
    // Other devices showing the same dialog close it too.
    hub.broadcast({ type: "dialog.closed", id: msg.id });
  });

  hub.handle("file.choose", async (msg) => {
    if (msg.type !== "file.choose") return;
    const c = choosers.get(msg.chooserId);
    choosers.delete(msg.chooserId);
    const files = msg.uploadIds.map(uploadPath).filter((f): f is string => !!f);
    if (!c || files.length === 0) return;
    await host.cdp?.send("DOM.setFileInputFiles", { files, backendNodeId: c.backendNodeId }, c.sessionId).catch(() => {});
  });

  hub.handle("file.cancel", (msg) => {
    if (msg.type === "file.cancel") choosers.delete(msg.chooserId);
  });
}
