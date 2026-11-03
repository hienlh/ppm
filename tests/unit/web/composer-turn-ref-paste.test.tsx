/**
 * Pasting turn links into a chat's composer: each becomes a chip that is resolved before the
 * message may go, the rest of the paste goes in untouched, and the chips travel as their own
 * field. They survive everything the reply does — a draft, a rejected send, an edit, a fork —
 * always as chips, never as the block's JSON.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { act } from "react";
import { toast } from "sonner";
import { installDom, uninstallDom, installGlobal, mount, click, type Mounted } from "../../helpers/react-dom";
import { encodeMessageBlocks } from "../../../src/shared/chat-message-blocks";
import type { TurnReference } from "../../../src/shared/chat-turn-ref";
installDom();
installGlobal("HTMLTextAreaElement", window.HTMLTextAreaElement);
afterAll(uninstallDom);
const { ChatTab } = await import("../../../src/web/components/chat/chat-tab");
const { api, ApiError } = await import("../../../src/web/lib/api-client");
const { WsClient } = await import("../../../src/web/lib/ws-client");
const { usePanelStore } = await import("../../../src/web/stores/panel-store");
const { useProjectStore } = await import("../../../src/web/stores/project-store");
const { clearChatPreparationCache } = await import("../../../src/web/lib/chat-preparation-cache");
const { __clearPrepareForTest } = await import("../../../src/web/lib/new-chat-prepare-client");
const { resetReadSessionTurnsCache } = await import("../../../src/web/hooks/use-read-session-turns-on");

const timestamp = "2026-10-01T10:00:00Z";
const SID = "aaaaaaaa-0000-4000-8000-000000000001";
const tid = (i: number) => `bbbbbbbb-1111-4000-8000-${String(i).padStart(12, "0")}`;
const link = (i: number, project = "other") => `https://tunnel.example/project/${project}/chat/claude/${SID}?turn=${tid(i)}`;
const refOf = (i: number): TurnReference => ({
  version: 1, projectName: "other", providerId: "claude", sessionId: SID, turnId: tid(i), n: i,
  title: "Other chat", prompt: "first line", at: "2026-10-01T09:00:00.000Z",
});
let view: Mounted | null = null;
let receive: ((event: MessageEvent) => void) | undefined;
let send: ReturnType<typeof spyOn>;
let transcript: Array<{ id: string; role: string; content: string; timestamp: string }>;
/** Turn ids the server answers as gone, and ones whose answer is held back. */
let gone: Set<string>;
let held: Map<string, () => void>;
const spies: Array<{ mockRestore(): void }> = [];

function Harness({ id = "chat-tab" }: { id?: string }) {
  const metadata = usePanelStore((state) => state.panels.main!.tabs.find((tab) => tab.id === id)!.metadata!);
  return <ChatTab tabId={id} metadata={metadata} />;
}
function turnMeta(path: string): Promise<unknown> {
  const turnId = decodeURIComponent(path.split("/turns/")[1]!.split("?")[0]!);
  if (gone.has(turnId)) return Promise.reject(new ApiError("No such turn in this session", 404, { ok: false, code: "not_found" }));
  const answer = { turnId, n: Number(turnId.slice(-4)), startedAt: "2026-10-01T09:00:00.000Z", prompt: "first line\nsecond line", messageCount: 2, status: "complete", sessionId: SID, providerId: "claude", sessionTitle: "Other chat" };
  if (!held.has(turnId)) return Promise.resolve(answer);
  return new Promise((resolve) => held.set(turnId, () => resolve(answer)));
}
beforeEach(() => {
  sessionStorage.clear(); localStorage.clear(); clearChatPreparationCache(); __clearPrepareForTest(); resetReadSessionTurnsCache();
  receive = undefined; gone = new Set(); held = new Map(); transcript = [{ id: "a1", role: "assistant", content: "hello", timestamp }];
  useProjectStore.setState({ projects: [{ name: "test", path: "/t" }, { name: "other", path: "/o" }] as never, activeProject: { name: "test", path: "/t" } as never });
  usePanelStore.setState({ currentProject: "test", focusedPanelId: "main", grid: [["main"]], lastFocusedChatProviders: {}, panels: { main: { id: "main", activeTabId: "chat-tab", tabHistory: ["chat-tab"], tabs: [{ id: "chat-tab", type: "chat", title: "Chat", projectId: "test", closable: true, metadata: { projectName: "test", sessionId: "s1", providerId: "codex" } }] } } });
  spies.push(spyOn(api, "get").mockImplementation(((path: string) => {
    if (path.includes("/turns/")) return turnMeta(path);
    if (path.includes("/chat/sessions?")) return Promise.resolve({ sessions: [], hasMore: false });
    if (path.includes("/drafts/")) return Promise.resolve(null);
    if (path.includes("/messages")) return Promise.resolve({ messages: transcript, versionMap: {} });
    if (path.includes("/settings")) return Promise.resolve({ default_provider: "codex", providers: { codex: { permission_mode: "plan" } } });
    if (path.includes("/providers")) return Promise.resolve([{ id: "codex", name: "Codex" }]);
    return Promise.resolve(null);
  }) as never), spyOn(api, "post").mockImplementation(((path: string) => Promise.resolve(path.includes("/fork?") ? { id: "forked" } : {})) as never),
  spyOn(api, "put").mockResolvedValue({}), spyOn(api, "del").mockResolvedValue(undefined),
  spyOn(WsClient.prototype, "connect").mockImplementation(() => {}),
  spyOn(WsClient.prototype, "onMessage").mockImplementation((handler) => { receive = handler; return () => { receive = undefined; }; }));
  send = spyOn(WsClient.prototype, "send").mockImplementation(() => {}); spies.push(send);
});
afterEach(async () => {
  await view?.unmount(); view = null;
  for (const spy of spies.splice(0)) spy.mockRestore();
  sessionStorage.clear(); localStorage.clear();
});
async function render(id = "chat-tab") { view = await mount(<Harness id={id} />); await frame({ type: "session_state", sessionId: "s1", phase: "idle", pendingApproval: null }); }
async function frame(data: unknown) { await act(async () => { receive!(new MessageEvent("message", { data: JSON.stringify(data) })); }); }
const settle = () => act(async () => { await Bun.sleep(5); });
function input() { return view!.container.querySelector("textarea")!; }
async function type(value: string, submit = false) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
    if (submit) input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}
async function paste(text: string): Promise<boolean> {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { items: [], getData: (type: string) => (type === "text/plain" ? text : "") } });
  await act(async () => { input().dispatchEvent(event); });
  await settle();
  return event.defaultPrevented;
}
async function key(name: string) {
  await act(async () => { input().dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })); });
  await settle();
}
const sent = () => send.mock.calls.map(([value]) => JSON.parse(String(value))).filter((value) => value.type === "message");
const composerChips = (status = "ready") => view!.container.querySelectorAll(`[data-composer-turn-refs] [data-turn-chip="${status}"]`);

describe("pasting turn links into the composer", () => {
  it("turns each link into a chip, inserts the rest untouched, and sends the chips as their own field", async () => {
    await render(); await type("look: ");
    expect(await paste(`${link(1)} and also ${link(2)}.`)).toBe(true);
    expect(input().value).toBe("look:  and also .");
    expect(composerChips()).toHaveLength(2);
    expect(composerChips()[0]!.textContent).toContain("Turn 1");
    await type("compare these", true);
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toMatchObject({ content: "compare these", turnRefs: [refOf(1), refOf(2)] });
    expect(composerChips()).toHaveLength(0);
    // The bubble drawn at send shows the chips, then takes the stored text the server acks.
    expect(view!.container.querySelectorAll('[data-turn-refs] [data-turn-chip="ready"]')).toHaveLength(2);
    const stored = encodeMessageBlocks("compare these", { turnRefs: [refOf(1), refOf(2)] });
    await frame({ type: "message_accepted", clientMessageId: sent()[0].clientMessageId, content: stored });
    expect(view!.container.querySelectorAll('[data-turn-refs] [data-turn-chip="ready"]')).toHaveLength(2);
  });

  it("types the rest of a paste in through the browser's editing, so undo and the change handling still apply", async () => {
    const doc = document as unknown as { execCommand?: (command: string, ui: boolean, text: string) => boolean };
    const before = Object.getOwnPropertyDescriptor(doc, "execCommand");
    const calls: string[][] = [];
    // What a browser does for insertText: replace the selection, then fire `input`.
    doc.execCommand = (command, _ui, text) => {
      calls.push([command, text]);
      const ta = document.activeElement as HTMLTextAreaElement;
      const next = ta.value.slice(0, ta.selectionStart) + text + ta.value.slice(ta.selectionEnd);
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(ta, next);
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    };
    try {
      await render(); await type("look:");
      input().focus();
      expect(await paste(`${link(1)} done`)).toBe(true);
      expect(calls).toEqual([["insertText", " done"]]);
      expect(input().value).toBe("look: done");
      // The composer heard it as an edit: Enter sends the text with the chip.
      await key("Enter");
      expect(sent()[0]).toMatchObject({ content: "look: done", turnRefs: [refOf(1)] });
    } finally {
      if (before) Object.defineProperty(doc, "execCommand", before);
      else delete doc.execCommand;
    }
  });

  it("holds the send while a chip loads, says why, and sends once it has", async () => {
    held.set(tid(3), () => {});
    await render(); await paste(link(3));
    expect(composerChips("loading")).toHaveLength(1);
    await type("wait for it", true);
    expect(sent()).toHaveLength(0);
    expect(view!.container.textContent).toContain("Loading the referenced turns");
    await act(async () => { held.get(tid(3))!(); });
    await settle();
    await type("wait for it", true);
    expect(sent()[0]).toMatchObject({ turnRefs: [refOf(3)] });
  });

  it("marks a turn that is gone, blocks the send until it is removed, then sends without it", async () => {
    gone.add(tid(4));
    await render(); await paste(link(4));
    expect(composerChips("error")[0]!.textContent).toContain("No longer available");
    await type("try", true);
    expect(sent()).toHaveLength(0);
    await click(view!.container.querySelector('[aria-label="Remove turn reference"]'));
    await type("try", true);
    expect(sent()[0].turnRefs).toBeUndefined();
  });

  it("keeps one chip per turn and at most ten, leaving the links over the limit in the text", async () => {
    const shown = spyOn(toast, "error").mockImplementation(() => 0);
    try {
      await render();
      expect(await paste(Array.from({ length: 12 }, (_, i) => link(i + 1)).join(" "))).toBe(true);
      expect(composerChips()).toHaveLength(10);
      // Nothing pasted is lost: the two that did not fit are still there, as the links they were.
      expect(input().value.trim()).toBe(`${link(11)} ${link(12)}`);
      expect(shown).toHaveBeenCalledTimes(1);
      // A turn already shown is dropped from the paste; there is a chip for it.
      await type("");
      expect(await paste(link(1))).toBe(true);
      expect(composerChips()).toHaveLength(10);
      expect(input().value).toBe("");
      // With no room at all the browser pastes the link as it is.
      expect(await paste(link(13))).toBe(false);
    } finally { shown.mockRestore(); }
  });

  it("adds what fits to the chips already there and keeps the rest of a paste as text", async () => {
    const shown = spyOn(toast, "error").mockImplementation(() => 0);
    try {
      await render();
      await paste(Array.from({ length: 9 }, (_, i) => link(i + 1)).join("\n"));
      expect(composerChips()).toHaveLength(9);
      await paste(`see ${link(20)} and ${link(21)} or ${link(22)}`);
      expect(composerChips()).toHaveLength(10);
      expect(input().value).toBe(`see  and ${link(21)} or ${link(22)}`);
    } finally { shown.mockRestore(); }
  });

  it("puts a recalled message's chips back with its text, and takes them away again", async () => {
    transcript.push({ id: "u1", role: "user", content: encodeMessageBlocks("old ask", { turnRefs: [refOf(8)] }), timestamp });
    await render();
    await key("ArrowUp");
    expect(input().value).toBe("old ask");
    expect(composerChips()).toHaveLength(1);
    await key("ArrowDown");
    expect(input().value).toBe("");
    expect(composerChips()).toHaveLength(0);
  });

  it("does not let recall replace chips the user has pasted", async () => {
    transcript.push({ id: "u1", role: "user", content: "old ask", timestamp });
    await render(); await paste(link(5));
    await key("ArrowUp");
    expect(input().value).toBe("");
    expect(composerChips()).toHaveLength(1);
  });

  it("leaves a link to a project this PPM does not have, and plain text, to the browser", async () => {
    await render();
    expect(await paste(`see ${link(5, "unknown")}`)).toBe(false);
    expect(await paste("just words")).toBe(false);
    expect(composerChips()).toHaveLength(0);
  });
});

describe("turn chips across drafts, rejections, edits and forks", () => {
  it("keeps chips in the draft and brings them back as chips after a reload", async () => {
    await render(); await paste(link(6)); await type("draft with a chip");
    const saved = [...Array(sessionStorage.length).keys()].map((i) => sessionStorage.getItem(sessionStorage.key(i)!) ?? "").join("");
    expect(saved).toContain("ppm-turnrefs-v1");
    await view!.unmount(); view = null; await render();
    expect(input().value).toBe("draft with a chip");
    expect(composerChips()).toHaveLength(1);
  });

  it("puts the chips back as chips when the send is rejected", async () => {
    await render(); await paste(link(7)); await type("go", true);
    await frame({ type: "message_rejected", clientMessageId: sent()[0].clientMessageId, content: "go", turnRefs: null, message: "Invalid turn reference" });
    expect(input().value).toBe("go");
    expect(composerChips()).toHaveLength(1);
    expect(input().value).not.toContain("ppm-turnrefs");
  });

  it("adds a rejected message's chips to ones pasted since, through the toast's Restore", async () => {
    const shown = spyOn(toast, "error").mockImplementation(() => 0);
    try {
      await render(); await paste(link(7)); await type("go", true);
      await paste(link(11)); await paste(link(7));
      await frame({ type: "message_rejected", clientMessageId: sent()[0].clientMessageId, content: "go", turnRefs: null, message: "Invalid turn reference" });
      const restore = shown.mock.calls.map(([, options]) => (options as { action?: { label: string; onClick(): void } } | undefined)?.action).find((a) => a?.label === "Restore")!;
      await act(async () => { restore.onClick(); });
      await settle();
      // Chips 11 and 7 were there; the rejected message's 7 is one of them, so nothing doubles.
      expect([...composerChips()].map((chip) => chip.textContent?.match(/Turn (\d+)/)?.[1])).toEqual(["11", "7"]);
      expect(input().value).toBe("go");
    } finally { shown.mockRestore(); }
  });

  it("gives a restored chip with no room left back as its link, in the text", async () => {
    const shown = spyOn(toast, "error").mockImplementation(() => 0);
    try {
      await render(); await paste(link(7)); await type("go", true);
      await paste(Array.from({ length: 10 }, (_, i) => link(i + 20)).join(" "));
      await frame({ type: "message_rejected", clientMessageId: sent()[0].clientMessageId, content: "go", turnRefs: null, message: "Invalid turn reference" });
      const restore = shown.mock.calls.map(([, options]) => (options as { action?: { label: string; onClick(): void } } | undefined)?.action).find((a) => a?.label === "Restore")!;
      await act(async () => { restore.onClick(); });
      await settle();
      expect(composerChips()).toHaveLength(10);
      expect(input().value).toBe(`go\n${window.location.origin}/project/other/chat/claude/${SID}?turn=${tid(7)}`);
    } finally { shown.mockRestore(); }
  });

  it("restores the body and chips of an edited message, and sends them with the edit", async () => {
    transcript.push({ id: "u1", role: "user", content: encodeMessageBlocks("old ask", { turnRefs: [refOf(8)] }), timestamp });
    await render(); await click(view!.container.querySelector('[aria-label="Edit"]'));
    expect(input().value).toBe("old ask");
    expect(composerChips()).toHaveLength(1);
    await type("new ask", true);
    await frame({ type: "session_state", sessionId: "forked", phase: "idle", pendingApproval: null });
    expect(sent().at(-1)).toMatchObject({ content: "new ask", turnRefs: [refOf(8)] });
  });

  it("opens a fork with the message's chips in its composer", async () => {
    transcript.push({ id: "u1", role: "user", content: encodeMessageBlocks("forked ask", { turnRefs: [refOf(9)] }), timestamp });
    await render(); await click(view!.container.querySelector('[aria-label="Fork"]'));
    const fork = usePanelStore.getState().panels.main!.tabs.find((tab) => tab.metadata?.sessionId === "forked")!;
    await view!.unmount(); view = null;
    await render(fork.id);
    expect(input().value).toBe("forked ask");
    expect(composerChips()).toHaveLength(1);
  });
});
