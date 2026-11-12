/**
 * Stops a chat's running turn the way PPM's own Stop button does: by connecting to the chat's
 * socket on the running server (`/ws/project/<project>/chat/<session>`) as an ordinary client and
 * sending `{ type: "cancel" }`. No other door is opened for the CLI; the server treats this
 * exactly as a browser's stop.
 *
 * Resolves once the frame has been sent and the socket is closed again; whether the turn really
 * ended is the caller's to check (it polls the server's running list).
 */
const CONNECT_TIMEOUT_MS = 10_000;

export function chatSocketPath(projectName: string, sessionId: string, providerId?: string): string {
  const query = providerId ? `?providerId=${encodeURIComponent(providerId)}` : "";
  return `/ws/project/${encodeURIComponent(projectName)}/chat/${encodeURIComponent(sessionId)}${query}`;
}

export function sendChatCancel(socketUrl: string, timeoutMs = CONNECT_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(socketUrl);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* already closed */ }
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error("The chat socket did not open in time")), timeoutMs);
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "cancel" }));
      // Closing right after `send` can drop the frame before it leaves; a short grace keeps it.
      setTimeout(() => finish(), 200);
    });
    ws.addEventListener("error", () => finish(new Error("Could not open the chat socket")));
    ws.addEventListener("close", (e) => {
      if (!settled) finish(new Error(`The chat socket closed before the stop was sent (code ${e.code})`));
    });
  });
}
