/**
 * A voice message handed back to the composer — by Edit, or because the send was rejected — comes
 * back as its words. The marker line and the recording's absolute path in the message box would be
 * sent as typed text, outside the transcript block, and a new recording would then put a second
 * marker in one message.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { act } from "react";
import { installDom, uninstallDom, installGlobal, mount, click, type Mounted } from "../../helpers/react-dom";
import { encodeVoicePart } from "../../../src/shared/voice-message";
installDom();
installGlobal("HTMLTextAreaElement", window.HTMLTextAreaElement);
afterAll(uninstallDom);
const { ChatTab } = await import("../../../src/web/components/chat/chat-tab");
const { api } = await import("../../../src/web/lib/api-client");
const { WsClient } = await import("../../../src/web/lib/ws-client");
const { usePanelStore } = await import("../../../src/web/stores/panel-store");
const { clearChatPreparationCache } = await import("../../../src/web/lib/chat-preparation-cache");
const { __clearPrepareForTest } = await import("../../../src/web/lib/new-chat-prepare-client");

const timestamp = "2026-11-20T10:00:00Z";
const PATH = "/home/u/.ppm/uploads/1a2b3c4d-voice-20261120T100000.webm";
const VOICE_MESSAGE = `Xem ảnh này\n\n${encodeVoicePart({ path: PATH, durationSec: 42, transcript: "sửa Hono middleware" })}`;
let view: Mounted | null = null;
let receive: ((event: MessageEvent) => void) | undefined;
let transcript: Array<{ id: string; role: string; content: string; timestamp: string }>;
const spies: Array<{ mockRestore(): void }> = [];

function Harness() {
  const metadata = usePanelStore((state) => state.panels.main!.tabs[0]!.metadata!);
  return <ChatTab tabId="voice-tab" metadata={metadata} />;
}

beforeEach(() => {
  sessionStorage.clear(); localStorage.clear(); clearChatPreparationCache(); __clearPrepareForTest();
  receive = undefined;
  transcript = [{ id: "a1", role: "assistant", content: "the AI answer", timestamp }];
  usePanelStore.setState({ currentProject: "test", focusedPanelId: "main", grid: [["main"]], lastFocusedChatProviders: {}, panels: { main: { id: "main", activeTabId: "voice-tab", tabHistory: ["voice-tab"], tabs: [{ id: "voice-tab", type: "chat", title: "Chat", projectId: "test", closable: true, metadata: { projectName: "test", sessionId: "s1", providerId: "codex" } }] } } });
  spies.push(spyOn(api, "get").mockImplementation((path: string) => {
    if (path.includes("/chat/sessions?")) return Promise.resolve({ sessions: [{ id: "s1", providerId: "codex", title: "first session", createdAt: timestamp, updatedAt: timestamp }], hasMore: false });
    if (path.includes("/drafts/")) return Promise.resolve(null);
    if (path.includes("/messages")) return Promise.resolve({ messages: transcript, versionMap: {} });
    if (path.includes("/settings")) return Promise.resolve({ default_provider: "codex", providers: { codex: { permission_mode: "plan" } } });
    if (path.includes("/providers")) return Promise.resolve([{ id: "codex", name: "Codex" }]);
    return Promise.resolve(null);
  }), spyOn(api, "post").mockResolvedValue({}), spyOn(api, "put").mockResolvedValue({}), spyOn(api, "del").mockResolvedValue(undefined),
  spyOn(WsClient.prototype, "connect").mockImplementation(() => {}),
  spyOn(WsClient.prototype, "onMessage").mockImplementation((handler) => { receive = handler; return () => { receive = undefined; }; }),
  spyOn(WsClient.prototype, "send").mockImplementation(() => {}));
});

afterEach(async () => {
  await view?.unmount(); view = null;
  for (const spy of spies.splice(0)) spy.mockRestore();
  sessionStorage.clear(); localStorage.clear(); clearChatPreparationCache(); __clearPrepareForTest();
});

async function render() {
  view = await mount(<Harness />);
  await frame({ type: "session_state", sessionId: "s1", phase: "idle", pendingApproval: null });
}
async function frame(data: unknown) { await act(async () => { receive!(new MessageEvent("message", { data: JSON.stringify(data) })); }); }
const input = () => view!.container.querySelector("textarea")!;
async function typeAndSend(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}

describe("a voice message handed back to the composer", () => {
  it("Edit puts back the typed text and the transcript, never the marker or the path", async () => {
    transcript.push({ id: "u1", role: "user", content: VOICE_MESSAGE, timestamp });
    await render();
    await click(view!.container.querySelector('[aria-label="Edit"]'));
    expect(input().value).toBe("Xem ảnh này\n\nsửa Hono middleware");
    expect(input().value).not.toContain("[Voice message");
    expect(input().value).not.toContain(PATH);
  });

  it("a rejected send puts back the words, never the marker or the path", async () => {
    await render();
    // Only a send that carries a reply (or chips) is handed back on rejection, so this one quotes.
    await click(view!.container.querySelector('[aria-label="Reply"]'));
    await typeAndSend(VOICE_MESSAGE);
    expect(input().value).toBe("");
    const sends = (WsClient.prototype.send as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map(([raw]) => JSON.parse(String(raw)) as { type: string; clientMessageId?: string })
      .filter((m) => m.type === "message");
    expect(sends).toHaveLength(1);
    await frame({ type: "message_rejected", clientMessageId: sends[0]!.clientMessageId, content: VOICE_MESSAGE, message: "Rejected" });
    expect(input().value).toBe("Xem ảnh này\n\nsửa Hono middleware");
    expect(input().value).not.toContain(PATH);
  });
});
