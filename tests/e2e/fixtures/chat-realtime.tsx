import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { useChat } from "../../../src/web/hooks/use-chat";

const state: any = { history: [], requests: 0, held: false, releases: [], socket: null };
(window as any).realtime = state;
window.fetch = (async (url: any) => {
  const data = String(url).includes("/messages") ? { messages: structuredClone(state.history), versionMap: {} } : [];
  if (String(url).includes("/messages")) {
    state.requests++;
    if (state.held) await new Promise<void>(resolve => state.releases.push(resolve));
  }
  return new Response(JSON.stringify({ ok: true, data }), { headers: { "Content-Type": "application/json" } });
}) as typeof fetch;
class Socket {
  static CONNECTING = 0; static OPEN = 1; static CLOSED = 3;
  readyState = 0;
  onopen: any; onclose: any; onmessage: any; onerror: any;
  constructor() { state.socket = this; setTimeout(() => { this.readyState = 1; this.onopen?.({}); }, 20); }
  send(data: string) {
    if (JSON.parse(data).type === "ready") setTimeout(() => state.emit({ type: "session_state", phase: "idle", sessionId: state.sessionId }), 20);
  }
  close() { this.readyState = 3; this.onclose?.({}); }
}
(window as any).WebSocket = Socket;
state.emit = (data: any) => state.socket.onmessage?.({ data: JSON.stringify(data) });
function Demo() {
  const [sessionId, setSession] = useState("realtime-test");
  state.sessionId = sessionId;
  state.setSession = setSession;
  const chat = useChat(sessionId, "claude", "test");
  state.chat = chat;
  return <pre id="state">{JSON.stringify({ phase: chat.phase, connected: chat.isConnected, messages: chat.messages }, null, 2)}</pre>;
}
createRoot(document.getElementById("root")!).render(<Demo />);

const wait = () => new Promise(resolve => setTimeout(resolve, 180));
const assert = (condition: unknown, label: string) => { if (!condition) throw new Error(label); };
async function verify() {
  await wait();
  state.chat.sendMessage("recover");
  await wait();
  state.history = [{ id: "u", role: "user", content: "recover" }, { id: "a", role: "assistant", content: "recovered" }];
  state.emit({ type: "phase_changed", phase: "thinking" });
  state.emit({ type: "phase_changed", phase: "idle" });
  await wait();
  assert(state.chat.messages.some((m: any) => m.content === "recovered"), "Missing completion was not recovered");

  const requests = state.requests;
  state.chat.sendMessage("normal");
  await wait();
  state.emit({ type: "phase_changed", phase: "streaming" });
  state.emit({ type: "text", content: "healthy" });
  state.emit({ type: "done", usage: { inputTokens: 123, outputTokens: 12 } });
  state.emit({ type: "phase_changed", phase: "idle" });
  await wait();
  assert(state.requests === requests, "Healthy completion unnecessarily refetched");
  assert(state.chat.messages.some((m: any) => m.content === "healthy" && m.usage), "Live usage was lost");

  state.held = true;
  state.releases = [];
  state.history = [{ id: "old", role: "user", content: "old" }];
  state.setSession("late-initial");
  await wait();
  state.history = [{ id: "new-u", role: "user", content: "latest" }, { id: "new-a", role: "assistant", content: "complete" }];
  state.emit({ type: "phase_changed", phase: "thinking" });
  state.emit({ type: "phase_changed", phase: "idle" });
  await wait();
  state.releases.pop()();
  await wait();
  for (const release of state.releases.splice(0)) release();
  await wait();
  assert(JSON.stringify(state.chat.messages.map((m: any) => m.content)) === JSON.stringify(["latest", "complete"]), "Late initial history overwrote or duplicated recovery");

  state.emit({ type: "phase_changed", phase: "streaming" });
  state.emit({ type: "turn_events", userMessage: "replay", events: Array.from({ length: 150 }, () => ({ type: "text", content: "x" })) });
  state.emit({ type: "text", content: "y" });
  state.emit({ type: "done" });
  state.emit({ type: "phase_changed", phase: "idle" });
  await wait();
  assert(state.chat.messages.at(-1)?.content === "x".repeat(150) + "y", "Live events overtook replay");
  state.result = "PASS: missing completion, healthy metadata, late history, ordered replay";
  document.title = state.result;
}
verify().catch(error => { state.result = `FAIL: ${error.message}`; document.title = state.result; console.error(error); });
