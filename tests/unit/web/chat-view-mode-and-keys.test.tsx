/**
 * Claude Code's view modes and chat keys in PPM: Ctrl+O cycles Normal → Thinking → Verbose (kept
 * per device), Thinking keeps every thinking block open, Verbose opens every tool card too; Alt
 * combos match a Mac's Option key by its physical key; a closed chat with a session can be reopened.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { installDom, uninstallDom, mount, type Mounted } from "../../helpers/react-dom.tsx";

installDom();
afterAll(uninstallDom);

const { act } = await import("react");
const { useChatViewMode } = await import("../../../src/web/stores/chat-view-mode-store.ts");
const { InterleavedEvents } = await import("../../../src/web/components/chat/message-events.tsx");
const { ToolCard } = await import("../../../src/web/components/chat/tool-cards.tsx");
const { KEY_ACTIONS, parseCombo, eventMatchesCombo } = await import("../../../src/web/stores/keybindings-store.ts");
const { rememberClosedTab, takeLastClosedChat } = await import("../../../src/web/lib/closed-chats.ts");
type ChatEvent = import("../../../src/types/chat.ts").ChatEvent;

let view: Mounted | null = null;
beforeEach(() => useChatViewMode.getState().setMode("normal"));
afterEach(async () => {
  await view?.unmount();
  view = null;
});

describe("view mode store", () => {
  it("cycles Normal → Thinking → Verbose → Normal and keeps the choice on the device", () => {
    const { cycle } = useChatViewMode.getState();
    cycle();
    expect(useChatViewMode.getState().mode).toBe("thinking");
    expect(localStorage.getItem("ppm.chat.viewMode")).toBe("thinking");
    cycle();
    expect(useChatViewMode.getState().mode).toBe("verbose");
    cycle();
    expect(useChatViewMode.getState().mode).toBe("normal");
  });

  it("Ctrl+O is its default key", () => {
    expect(KEY_ACTIONS.find((a) => a.id === "chat-view-mode")?.defaultKey).toBe("Ctrl+O");
  });
});

describe("what each mode opens", () => {
  const bash: ChatEvent = { type: "tool_use", tool: "Bash", input: { command: "echo hi" }, toolUseId: "t1" };
  const bashOut: ChatEvent = { type: "tool_result", output: "hi-from-bash", toolUseId: "t1" };

  it("Verbose opens a tool card, and going back folds it again", async () => {
    view = await mount(<ToolCard tool={bash} result={bashOut} completed />);
    expect(view.container.textContent).not.toContain("hi-from-bash");
    await act(async () => useChatViewMode.getState().setMode("verbose"));
    expect(view.container.textContent).toContain("hi-from-bash");
    await act(async () => useChatViewMode.getState().setMode("normal"));
    expect(view.container.textContent).not.toContain("hi-from-bash");
  });

  it("a card mounted in Verbose starts open", async () => {
    useChatViewMode.getState().setMode("verbose");
    view = await mount(<ToolCard tool={bash} result={bashOut} completed />);
    expect(view.container.textContent).toContain("hi-from-bash");
  });

  it("Thinking keeps a finished thinking block open; Normal folds it", async () => {
    const events: ChatEvent[] = [{ type: "thinking", content: "pondering deeply" }, { type: "text", content: "done" }];
    view = await mount(<InterleavedEvents events={events} isStreaming={false} />);
    const block = () => view!.container.querySelector("[data-thinking-block]")!;
    expect(block().hasAttribute("data-expanded")).toBe(false);
    await act(async () => useChatViewMode.getState().setMode("thinking"));
    expect(block().hasAttribute("data-expanded")).toBe(true);
    expect(block().textContent).toContain("pondering deeply");
    await act(async () => useChatViewMode.getState().setMode("normal"));
    expect(block().hasAttribute("data-expanded")).toBe(false);
  });
});

describe("Alt combos on a Mac", () => {
  it("match by the physical key when Option turned the letter into another character", () => {
    const combo = parseCombo("Alt+T");
    const ev = (key: string, code: string) => new KeyboardEvent("keydown", { key, code, altKey: true });
    expect(eventMatchesCombo(ev("t", "KeyT"), combo)).toBe(true);
    expect(eventMatchesCombo(ev("†", "KeyT"), combo)).toBe(true);
    expect(eventMatchesCombo(ev("π", "KeyP"), combo)).toBe(false);
    // Without Alt the physical key is not enough.
    expect(eventMatchesCombo(new KeyboardEvent("keydown", { key: "x", code: "KeyT" }), parseCombo("T"))).toBe(false);
  });
});

describe("closed chats", () => {
  it("keeps chats with a session, newest last, once each", () => {
    rememberClosedTab({ type: "chat", title: "A", metadata: { projectName: "p", sessionId: "s1", providerId: "codex" } });
    rememberClosedTab({ type: "chat", metadata: { projectName: "p" } });
    rememberClosedTab({ type: "editor", metadata: { projectName: "p", sessionId: "x" } });
    rememberClosedTab({ type: "chat", metadata: { projectName: "p", sessionId: "s2" } });
    rememberClosedTab({ type: "chat", title: "A again", metadata: { projectName: "p", sessionId: "s1", providerId: "codex" } });
    expect(takeLastClosedChat()).toEqual({ projectName: "p", sessionId: "s1", providerId: "codex", title: "A again" });
    expect(takeLastClosedChat()).toEqual({ projectName: "p", sessionId: "s2", providerId: "claude" });
    expect(takeLastClosedChat()).toBeNull();
  });
});
