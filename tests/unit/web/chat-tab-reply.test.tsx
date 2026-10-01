import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { act } from "react";
import { installDom, uninstallDom, installGlobal, mount, click, type Mounted } from "../../helpers/react-dom";
import { decodeReply, encodeReply, type ReplyReference } from "../../../src/shared/chat-reply";
installDom();
installGlobal("HTMLTextAreaElement", window.HTMLTextAreaElement);
afterAll(uninstallDom);
const { ChatTab } = await import("../../../src/web/components/chat/chat-tab");
const { api } = await import("../../../src/web/lib/api-client");
const { WsClient } = await import("../../../src/web/lib/ws-client");
const { usePanelStore } = await import("../../../src/web/stores/panel-store");
const { useSessionListStore } = await import("../../../src/web/stores/session-list-store");
const { clearChatPreparationCache } = await import("../../../src/web/lib/chat-preparation-cache");
const { __clearPrepareForTest } = await import("../../../src/web/lib/new-chat-prepare-client");
const timestamp = "2026-10-01T10:00:00Z";
const reference: ReplyReference = { version: 1, sessionId: "s1", providerId: "codex", messageId: "a1", role: "assistant", timestamp, quote: "the AI answer", truncated: false };
let view: Mounted | null = null;
let receive: ((event: MessageEvent) => void) | undefined;
let send: ReturnType<typeof spyOn>;
let transcript: Array<{ id: string; role: string; content: string; timestamp: string }>;
let draftsBySession: Record<string, { content: string; attachments: string; updatedAt: string } | null>;
let draft: { content: string; attachments: string; updatedAt: string } | null;
const spies: Array<{ mockRestore(): void }> = [];
function Harness() {
  const metadata = usePanelStore((state) => state.panels.main!.tabs[0]!.metadata!);
  return <ChatTab tabId="reply-tab" metadata={metadata} />;
}
function TabHarness({ id }: { id: string }) {
  const metadata = usePanelStore((state) => state.panels.main!.tabs.find((tab) => tab.id === id)!.metadata!);
  return <ChatTab tabId={id} metadata={metadata} />;
}
beforeEach(() => {
  sessionStorage.clear(); localStorage.clear(); clearChatPreparationCache(); __clearPrepareForTest();
  draftsBySession = {}; draft = null; receive = undefined; transcript = [{ id: "a1", role: "assistant", content: "the AI answer", timestamp }];
  usePanelStore.setState({ currentProject: "test", focusedPanelId: "main", grid: [["main"]], lastFocusedChatProviders: {}, panels: { main: { id: "main", activeTabId: "reply-tab", tabHistory: ["reply-tab"], tabs: [{ id: "reply-tab", type: "chat", title: "Chat", projectId: "test", closable: true, metadata: { projectName: "test", sessionId: "s1", providerId: "codex" } }] } } });
  spies.push(spyOn(api, "get").mockImplementation((path: string) => {
    if (path.includes("/chat/sessions?")) return Promise.resolve({ sessions: [{ id: "s1", providerId: "codex", title: "first session", createdAt: timestamp, updatedAt: timestamp }, { id: "s2", providerId: "codex", title: "other session", createdAt: timestamp, updatedAt: timestamp }], hasMore: false });
    if (path.includes("/drafts/")) return Promise.resolve(draftsBySession[path.split("/drafts/")[1]!] ?? draft);
    if (path.includes("/messages")) return Promise.resolve({ messages: transcript, versionMap: {} });
    if (path.includes("/settings")) return Promise.resolve({ default_provider: "codex", providers: { codex: { permission_mode: "plan" } } });
    if (path.includes("/providers")) return Promise.resolve([{ id: "codex", name: "Codex" }]);
    if (path.includes("/usage")) return Promise.resolve(null);
    return Promise.resolve([]);
  }), spyOn(api, "post").mockImplementation((path: string) => Promise.resolve(path.includes("/fork?") ? { id: "forked" } : {})), spyOn(api, "put").mockResolvedValue({}), spyOn(api, "del").mockResolvedValue(undefined), spyOn(WsClient.prototype, "connect").mockImplementation(() => {}), spyOn(WsClient.prototype, "onMessage").mockImplementation((handler) => { receive = handler; return () => { receive = undefined; }; }));
  send = spyOn(WsClient.prototype, "send").mockImplementation(() => {}); spies.push(send);
});
afterEach(async () => {
  await view?.unmount(); view = null;
  for (const spy of spies.splice(0)) spy.mockRestore();
  sessionStorage.clear(); localStorage.clear(); clearChatPreparationCache(); __clearPrepareForTest();
});
async function render() { view = await mount(<Harness />); await frame({ type: "session_state", sessionId: "s1", phase: "idle", pendingApproval: null }); }
async function frame(data: unknown) { await act(async () => { receive!(new MessageEvent("message", { data: JSON.stringify(data) })); }); }
function input() { return view!.container.querySelector("textarea")!; }
async function type(value: string, submit = false) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
    if (submit) input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}
function sent() { return send.mock.calls.map(([value]) => JSON.parse(String(value))).filter((value) => value.type === "message"); }
function preview() { return view!.container.querySelector('[aria-label="Cancel reply"]'); }
function setTabSession(sessionId: string) {
  const tab = usePanelStore.getState().panels.main!.tabs[0]!;
  usePanelStore.setState((state) => ({ panels: { main: { ...state.panels.main!, tabs: [{ ...tab, metadata: { ...tab.metadata, sessionId } }] } } }));
}
async function selectHistory(title: string) {
  await click([...view!.container.querySelectorAll("button")].find((button) => button.textContent === "History") ?? null);
  await click([...view!.container.querySelectorAll("button")].find((button) => button.textContent?.includes(title)) ?? null);
}
describe("ChatTab reply composer", () => {
  it("selection and cancel preserve the text being drafted", async () => {
    await render(); await type("keep this draft");
    await click(view!.container.querySelector('[aria-label="Reply"]'));
    expect(input().value).toBe("keep this draft"); expect(!!preview()).toBe(true);
    await click(preview());
    expect(input().value).toBe("keep this draft"); expect(!!preview()).toBe(false);
  });
  it("sends separate reply metadata, renders the quote, and restores both after rejection", async () => {
    await render(); await click(view!.container.querySelector('[aria-label="Reply"]'));
    await type("follow up", true);
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toMatchObject({ content: "follow up", replyTo: reference });
    expect(input().value).toBe(""); expect(!!preview()).toBe(false);
    expect(view!.container.textContent).toContain("Reply to AI");
    await frame({ type: "message_rejected", content: "follow up", replyTo: reference, message: "Invalid reply" });
    expect(input().value).toBe("follow up"); expect(!!preview()).toBe(true);
    expect(view!.container.textContent).toContain("Replying to AI");
  });
  it("keeps reply and text when a local /clear command is rejected", async () => {
    await render(); await click(view!.container.querySelector('[aria-label="Reply"]'));
    await type("/clear", true);
    expect(input().value).toBe("/clear"); expect(!!preview()).toBe(true);
    expect(sent()).toHaveLength(0);
    expect(usePanelStore.getState().panels.main!.tabs[0]!.metadata!.sessionId).toBe("s1");
  });
  it("editing a sent reply restores its body and snapshot", async () => {
    transcript.push({ id: "u1", role: "user", content: encodeReply("old follow up", reference), timestamp });
    await render(); await type("current draft");
    await click(view!.container.querySelector('[aria-label="Edit"]'));
    expect(input().value).toBe("old follow up"); expect(!!preview()).toBe(true);
    expect(view!.container.textContent).toContain("Replying to AI");
  });
  it("hydrates an encoded server draft with attachment and quote and retains them on selection", async () => {
    draft = { content: encodeReply("saved draft", reference), attachments: JSON.stringify([{ name: "notes.txt", path: "/tmp/notes.txt" }]), updatedAt: timestamp };
    await render();
    expect(input().value).toBe("saved draft"); expect(!!preview()).toBe(true); expect(view!.container.textContent).toContain("notes.txt");
    await click(view!.container.querySelector('[aria-label="Reply"]'));
    expect(input().value).toBe("saved draft"); expect(view!.container.textContent).toContain("notes.txt");
    await click(preview());
    expect(input().value).toBe("saved draft"); expect(view!.container.textContent).toContain("notes.txt");
  });
  it("recovers a locally saved reply draft after reload", async () => {
    await render(); await type("local draft"); await click(view!.container.querySelector('[aria-label="Reply"]'));
    await view!.unmount(); view = null; await render();
    expect(input().value).toBe("local draft"); expect(!!preview()).toBe(true);
  });
  it("does not carry reply selection when changing session", async () => {
    await render(); await click(view!.container.querySelector('[aria-label="Reply"]'));
    await click([...view!.container.querySelectorAll("button")].find((button) => button.textContent === "History") ?? null);
    await click([...view!.container.querySelectorAll("button")].find((button) => button.textContent?.includes("other session")) ?? null);
    expect(!!preview()).toBe(false);
  });
  it("preserves edited quote in outbound fork continuation", async () => {
    transcript.push({ id: "u1", role: "user", content: encodeReply("old follow up", reference), timestamp });
    await render(); await click(view!.container.querySelector('[aria-label="Edit"]'));
    await type("edited follow up", true);
    await frame({ type: "session_state", sessionId: "forked", phase: "idle", pendingApproval: null });
    expect(sent()).toHaveLength(1);
    // Beside the text, where the server checks it, and naming the conversation the edit continues.
    expect(sent()[0]).toMatchObject({ content: "edited follow up", replyTo: { ...reference, sessionId: "forked" } });
  });
  it("hands an edit back as the fork's reply when the chat changes before the fork connects", async () => {
    transcript.push({ id: "u1", role: "user", content: encodeReply("old follow up", reference), timestamp });
    await render(); await click(view!.container.querySelector('[aria-label="Edit"]'));
    await type("edited follow up", true);
    await selectHistory("other session");
    // Reopened, the fork offers the edit back with a reply its own session accepts — not the
    // source's, which the server would refuse on every send.
    await view!.unmount(); view = null;
    setTabSession("forked");
    view = await mount(<Harness />);
    await frame({ type: "session_state", sessionId: "forked", phase: "idle", pendingApproval: null });
    expect(input().value).toBe("edited follow up"); expect(!!preview()).toBe(true);
    await type("edited follow up", true);
    expect(sent().at(-1)).toMatchObject({ content: "edited follow up", replyTo: { ...reference, sessionId: "forked" } });
  });
  it("keeps the quote when editing a reply copied in from the conversation this one forked from", async () => {
    transcript.push({ id: "u1", role: "user", content: encodeReply("old follow up", { ...reference, sessionId: "parent" }), timestamp });
    await render(); await click(view!.container.querySelector('[aria-label="Edit"]'));
    expect(!!preview()).toBe(true);
    await type("edited follow up", true);
    await frame({ type: "session_state", sessionId: "forked", phase: "idle", pendingApproval: null });
    expect(sent()[0]).toMatchObject({ content: "edited follow up", replyTo: { ...reference, sessionId: "forked" } });
  });
  it("opens a fork of a reply with its body in the composer and its quote as the fork's reply", async () => {
    useSessionListStore.setState({ byProject: {} });
    transcript.push({ id: "u1", role: "user", content: encodeReply("old follow up", reference), timestamp });
    await render(); await click(view!.container.querySelector('[aria-label="Fork"]'));
    const fork = usePanelStore.getState().panels.main!.tabs.find((tab) => tab.metadata?.sessionId === "forked")!;
    expect(fork.title).toBe("Fork: old follow up");
    expect(Object.values(useSessionListStore.getState().byProject).flatMap((state) => state.sessions).find((s) => s.id === "forked")?.title).toBe("old follow up");
    // What an edit does: the body to type over, and the quote as a reply in the conversation the
    // fork copied it into — which is the one the server accepts it for.
    await view!.unmount(); view = null;
    view = await mount(<TabHarness id={fork.id} />);
    await frame({ type: "session_state", sessionId: "forked", phase: "idle", pendingApproval: null });
    expect(input().value).toBe("old follow up"); expect(!!preview()).toBe(true);
    await type("old follow up", true);
    expect(sent().at(-1)).toMatchObject({ content: "old follow up", replyTo: { ...reference, sessionId: "forked" } });
  });
  it("sends a draft without a reply that belongs to another conversation", async () => {
    for (const foreign of [{ ...reference, sessionId: "elsewhere" }, { ...reference, providerId: "claude" }]) {
      draft = { content: encodeReply("stuck draft", foreign), attachments: "[]", updatedAt: timestamp };
      sessionStorage.clear();
      await render();
      expect(input().value).toBe("stuck draft"); expect(!!preview()).toBe(false);
      await type("stuck draft", true);
      expect(sent().at(-1).replyTo).toBeUndefined();
      expect(sent().at(-1).content).toBe("stuck draft");
      await view!.unmount(); view = null;
    }
  });
  it("leaves newer text intact when an older reply is rejected", async () => {
    await render(); await click(view!.container.querySelector('[aria-label="Reply"]')); await type("old reply", true);
    await type("new draft");
    await frame({ type: "message_rejected", content: "old reply", replyTo: reference, message: "Rejected" });
    expect(input().value).toBe("new draft"); expect(!!preview()).toBe(false);
  });
  it("recovers text and reply after selecting another session and returning", async () => {
    await render(); await type("keep first draft"); await click(view!.container.querySelector('[aria-label="Reply"]'));
    await selectHistory("other session");
    expect(input().value).toBe(""); expect(!!preview()).toBe(false);
    await selectHistory("first session");
    expect(input().value).toBe("keep first draft"); expect(!!preview()).toBe(true);
  });
  it("hydrates the target session's saved attachments after navigation", async () => {
    await render();
    draftsBySession.s2 = { content: "other draft", attachments: JSON.stringify([{ name: "other-notes.txt", path: "/tmp/other-notes.txt" }]), updatedAt: timestamp };
    await selectHistory("other session");
    expect(input().value).toBe("other draft"); expect(view!.container.textContent).toContain("other-notes.txt");
  });
  it("keeps a source snapshot readable after reload changes its adapter id", async () => {
    transcript = [{ id: "renumbered-7", role: "assistant", content: "the AI answer", timestamp: "2026-10-02T10:00:00Z" }, { id: "u1", role: "user", content: encodeReply("follow up", reference), timestamp }];
    await render();
    expect(view!.container.textContent).toContain("Original message unavailable");
    expect(view!.container.textContent).toContain(reference.quote);
    const sourceButton = [...view!.container.querySelectorAll("button")].find((button) => button.textContent === "Reply to AI");
    expect(sourceButton?.disabled).toBe(true);
  });

  it("recalling history drops the selected reply before sending", async () => {
    transcript.push({ id: "u1", role: "user", content: encodeReply("previous body", reference), timestamp });
    await render(); await click(view!.container.querySelector('[aria-label="Reply"]'));
    await act(async () => { input().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })); });
    expect(input().value).toBe("previous body"); expect(!!preview()).toBe(false);
    await type("previous body", true);
    expect(sent()[0].replyTo).toBeUndefined();
    expect(sent()[0].content).toBe("previous body");
  });

  it("hydrates attachments when the server draft arrives after the draft gate releases", async () => {
    let resolveDraft!: (value: unknown) => void;
    const pendingDraft = new Promise((resolve) => { resolveDraft = resolve; });
    const late = spyOn(api, "get").mockImplementation((path: string) => {
      if (path.includes("/drafts/")) return pendingDraft;
      if (path.includes("/messages")) return Promise.resolve({ messages: transcript, versionMap: {} });
      if (path.includes("/settings")) return Promise.resolve({ default_provider: "codex", providers: { codex: { permission_mode: "plan" } } });
      if (path.includes("/providers")) return Promise.resolve([{ id: "codex", name: "Codex" }]);
      if (path.includes("/usage")) return Promise.resolve(null);
      return Promise.resolve([]);
    });
    spies.push(late);
    await render();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 3100)); });
    await act(async () => { resolveDraft({ content: encodeReply("late body", reference), attachments: JSON.stringify([{ name: "late.txt", path: "/tmp/late.txt" }]), updatedAt: timestamp }); });
    expect(input().value).toBe("late body"); expect(!!preview()).toBe(true);
    expect(view!.container.textContent).toContain("late.txt");
  });

  it("keeps the composed reply when the provider adopts a native session ID", async () => {
    await render(); await type("unsent body"); await click(view!.container.querySelector('[aria-label="Reply"]'));
    await frame({ type: "session_migrated", newSessionId: "native-session" });
    expect(input().value).toBe("unsent body"); expect(!!preview()).toBe(true);
    await type("unsent body", true);
    expect(sent()[0].replyTo.sessionId).toBe("native-session");
    expect(sent()[0].replyTo.quote).toBe("the AI answer");
  });

  it("does not resurrect erased draft text during native session migration", async () => {
    draft = { content: encodeReply("erase this", reference), attachments: "[]", updatedAt: timestamp };
    await render(); await type("");
    await frame({ type: "session_migrated", newSessionId: "native-session" });
    expect(input().value).toBe(""); expect(!!preview()).toBe(true);
    const saved = JSON.parse(sessionStorage.getItem(`ppm-chat-draft:${JSON.stringify(["test", "reply-tab", "native-session"])}`)!);
    expect(decodeReply(saved.content).content).toBe("");
  });

});
