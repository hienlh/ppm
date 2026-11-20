/**
 * The composer's voice message comes back with the chat's draft (a reload, another device): the
 * chip and the transcript as they were, or — when the page went while it was being transcribed —
 * the chip alone with "Transcribe again". Every change is saved with the draft, × and a send take
 * it out of the draft, and × still deletes the upload.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { act } from "react";
import { installDom, uninstallDom, installGlobal, mount, click, type Mounted } from "../../helpers/react-dom";
import type { StoredVoiceDraft } from "../../../src/shared/voice-draft";
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
const FILE = "1a2b3c4d-voice-20261120T100000.webm";
const PATH = `/home/u/.ppm/uploads/${FILE}`;
const READY: StoredVoiceDraft = {
  path: PATH,
  durationSec: 42,
  transcript: {
    text: "sửa Hono middleware, edited", shown: "sửa Hono middleware", raw: "sửa hono mid lơ wear",
    cleaned: true, transcribeMs: 2100, cleanupMs: 900,
    timings: { browserConvertMs: 120, requestMs: 3400, transcribeMs: 2100, cleanupMs: 900, cleaned: true },
  },
};
const LOCAL_KEY = `ppm-chat-draft:${JSON.stringify(["test", "voice-tab", "s1"])}`;

let view: Mounted | null = null;
let receive: ((event: MessageEvent) => void) | undefined;
let serverVoice: unknown;
let fetchCalls: Array<{ url: string; method: string; auth: string | null }>;
const spies: Array<{ mockRestore(): void }> = [];
const realFetch = globalThis.fetch;

function Harness() {
  const metadata = usePanelStore((state) => state.panels.main!.tabs[0]!.metadata!);
  return <ChatTab tabId="voice-tab" metadata={metadata} />;
}

beforeEach(() => {
  sessionStorage.clear(); localStorage.clear(); clearChatPreparationCache(); __clearPrepareForTest();
  localStorage.setItem("ppm-auth-token", "tok");
  receive = undefined;
  fetchCalls = [];
  usePanelStore.setState({ currentProject: "test", focusedPanelId: "main", grid: [["main"]], lastFocusedChatProviders: {}, panels: { main: { id: "main", activeTabId: "voice-tab", tabHistory: ["voice-tab"], tabs: [{ id: "voice-tab", type: "chat", title: "Chat", projectId: "test", closable: true, metadata: { projectName: "test", sessionId: "s1", providerId: "codex" } }] } } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    fetchCalls.push({ url: String(input), method: init?.method ?? "GET", auth: headers.get("Authorization") });
    return new Response(new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }), { status: 200 });
  }) as typeof fetch;
  spies.push(spyOn(api, "get").mockImplementation((path: string) => {
    if (path.includes("/chat/sessions?")) return Promise.resolve({ sessions: [{ id: "s1", providerId: "codex", title: "first session", createdAt: timestamp, updatedAt: timestamp }], hasMore: false });
    if (path.includes("/drafts/")) return Promise.resolve({ content: "typed above", attachments: "[]", voice: serverVoice, updatedAt: timestamp });
    if (path.includes("/messages")) return Promise.resolve({ messages: [], versionMap: {} });
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
  globalThis.fetch = realFetch;
  sessionStorage.clear(); localStorage.clear(); clearChatPreparationCache(); __clearPrepareForTest();
});

async function render() {
  view = await mount(<Harness />);
  await act(async () => { receive!(new MessageEvent("message", { data: JSON.stringify({ type: "session_state", sessionId: "s1", phase: "idle", pendingApproval: null }) })); });
}
const $ = (selector: string) => view!.container.querySelector(selector);
const transcriptBox = () => $('[aria-label="Voice message transcript"]') as HTMLTextAreaElement | null;
const buttonByText = (text: string) =>
  [...view!.container.querySelectorAll("button")].find((b) => b.textContent?.includes(text)) as HTMLButtonElement | undefined;
const savedVoice = () => (JSON.parse(sessionStorage.getItem(LOCAL_KEY) ?? "null") as { voice?: StoredVoiceDraft | null } | null)?.voice;
async function setValue(el: HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("a voice message kept in the chat draft", () => {
  it("comes back as the chip and the transcript, with the edited text and Whisper's original", async () => {
    serverVoice = READY;
    await render();
    expect($("[data-voice-chip]")).not.toBeNull();
    expect(transcriptBox()?.value).toBe("sửa Hono middleware, edited");
    await click($('[aria-label="Show the time each step took"]'));
    await click(buttonByText("Whisper's original"));
    expect(view!.container.textContent).toContain("sửa hono mid lơ wear");
    // A restored draft is never sent by itself.
    const sends = (WsClient.prototype.send as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .filter(([raw]) => JSON.parse(String(raw)).type === "message");
    expect(sends).toHaveLength(0);
  });

  it("saves every edit of the transcript, and Use the original, with the draft", async () => {
    serverVoice = READY;
    await render();
    await setValue(transcriptBox()!, "edited again");
    expect(savedVoice()?.transcript?.text).toBe("edited again");
    expect(savedVoice()?.path).toBe(PATH);
    await click($('[aria-label="Show the time each step took"]'));
    await click(buttonByText("Whisper's original"));
    await click(buttonByText("Use the original"));
    expect(savedVoice()?.transcript?.text).toBe("sửa hono mid lơ wear");
    expect(transcriptBox()?.value).toBe("sửa hono mid lơ wear");
  });

  it("× takes it out of the draft and deletes the upload", async () => {
    serverVoice = READY;
    await render();
    await click($('[aria-label="Remove voice message"]'));
    expect($("[data-voice-chip]")).toBeNull();
    expect(savedVoice()).toBeNull();
    expect(fetchCalls.some((c) => c.method === "DELETE" && c.url.endsWith(`/chat/uploads/${FILE}`))).toBe(true);
  });

  it("a send takes it out of the draft, keeps the upload, and carries it in the message", async () => {
    serverVoice = READY;
    await render();
    await act(async () => {
      transcriptBox()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    const sends = (WsClient.prototype.send as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map(([raw]) => JSON.parse(String(raw)) as { type: string; content?: string })
      .filter((m) => m.type === "message");
    expect(sends).toHaveLength(1);
    expect(sends[0]!.content).toContain(PATH);
    expect(sends[0]!.content).toContain("sửa Hono middleware, edited");
    expect($("[data-voice-chip]")).toBeNull();
    // Either the send's own save (voice: null) or, once the socket took it, no draft at all.
    expect(savedVoice() ?? null).toBeNull();
    expect(fetchCalls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("still being transcribed when the page went: the chip alone, with Transcribe again on the upload", async () => {
    serverVoice = { path: PATH, durationSec: 9 };
    await render();
    expect($("[data-voice-chip]")).not.toBeNull();
    expect(transcriptBox()).toBeNull();
    const again = buttonByText("Transcribe again");
    expect(again).toBeDefined();
    await click(again!);
    // The browser holds no recording: it reads the uploaded copy back, with the token.
    const read = fetchCalls.find((c) => c.method === "GET" && c.url.endsWith(`/chat/uploads/${FILE}`));
    expect(read?.auth).toBe("Bearer tok");
  });

  it("closing the chat keeps the upload the draft names", async () => {
    serverVoice = READY;
    await render();
    await view!.unmount(); view = null;
    expect(fetchCalls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("a voice the draft does not hold as a stored recording does not come back", async () => {
    serverVoice = { ...READY, path: "/etc/passwd.webm" };
    await render();
    expect($("[data-voice-chip]")).toBeNull();
  });

  it("a draft with no voice loads as before", async () => {
    serverVoice = undefined;
    await render();
    expect($("[data-voice-chip]")).toBeNull();
    expect((view!.container.querySelector('textarea[aria-label="Message"]') as HTMLTextAreaElement).value).toBe("typed above");
  });
});
