// Isolated browser fixture: real chat UI, controlled HTTP/socket failures.
import React from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import { ChatTab } from "../../../src/web/components/chat/chat-tab";

const mode = new URL(location.href).searchParams.get("mode") ?? "stall";
const state = { posts: 0, messages: 0, mode, loadId: crypto.randomUUID() };
(window as any).recovery = state;
window.fetch = (async (input: RequestInfo | URL, options?: RequestInit) => {
  const path = String(input);
  if (options?.method === "POST" && path.endsWith("/chat/sessions")) {
    state.posts++;
    if (mode === "stall") return await new Promise<Response>((_, reject) => {
      options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
    });
    sessionStorage.setItem("fixture-session", "recovery-session");
    return Response.json({ ok: true, data: { id: "recovery-session", providerId: "claude" } });
  }
  let data: unknown = [];
  if (path.includes("/drafts/") || path.includes("/usage")) data = null;
  if (path.includes("/settings/ai")) data = { providers: {} };
  if (path.includes("/messages")) data = { messages: [], versionMap: {} };
  return Response.json({ ok: true, data });
}) as typeof fetch;

class Socket {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = 0;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  constructor() {
    setTimeout(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.onopen?.();
    }, 10);
  }
  send(value: string) {
    const frame = JSON.parse(value);
    if (frame.type === "message") state.messages++;
    if (frame.type === "ready" && mode !== "no-ws") setTimeout(() => this.onmessage?.({ data: JSON.stringify({
      type: "session_state", sessionId: "recovery-session", phase: "idle", pendingApproval: null,
    }) }), 10);
  }
  close() { this.readyState = 3; }
}
(window as any).WebSocket = Socket;
class Events { close() {} addEventListener() {} removeEventListener() {} }
(window as any).EventSource = Events;

createRoot(document.getElementById("root")!).render(<>
  <ChatTab tabId="recovery-tab" metadata={{
    projectName: "recovery-test", permissionMode: "bypassPermissions",
    sessionId: sessionStorage.getItem("fixture-session") ?? undefined,
    pickedAccountProvider: "claude", pickedAccountId: "fixture",
  }} />
  <Toaster />
</>);
