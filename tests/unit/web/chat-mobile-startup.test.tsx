import { afterAll, afterEach, expect, it, spyOn } from "bun:test";
import { act, useState } from "react";
import { installDom, uninstallDom, mount, type Mounted } from "../../helpers/react-dom";

installDom();
afterAll(uninstallDom);
const { useChat } = await import("../../../src/web/hooks/use-chat");
const { MessageInput } = await import("../../../src/web/components/chat/message-input");
const { SlashCommandPicker } = await import("../../../src/web/components/chat/slash-command-picker");
import type { SlashItem } from "../../../src/web/components/chat/slash-command-picker";
const { api } = await import("../../../src/web/lib/api-client");
const { WsClient } = await import("../../../src/web/lib/ws-client");
const { clearSlashItemsCache } = await import("../../../src/web/lib/slash-items-cache");
const { useFileStore } = await import("../../../src/web/stores/file-store");
let view: Mounted | null = null;
const spies: Array<{ mockRestore(): void }> = [];
const initialFileState = useFileStore.getState();
afterEach(async () => {
  await view?.unmount();
  view = null;
  for (const spy of spies.splice(0)) spy.mockRestore();
  clearSlashItemsCache("mobile-startup");
  useFileStore.setState(initialFileState, true);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

for (const recovery of ["phase_changed", "session_state"] as const) {
  it(`shares slow startup history with the idle greeting and still recovers a completed turn via ${recovery}`, async () => {
    const initial = deferred<unknown>();
    const recovered = deferred<unknown>();
    let historyRequests = 0;
    const get = spyOn(api, "get").mockImplementation((path: string) => {
      if (path === "/api/teams") return Promise.resolve([]);
      if (!path.includes("/messages?")) throw new Error(`Unexpected GET: ${path}`);
      return ++historyRequests === 1 ? initial.promise : recovered.promise;
    });
    let receive!: (event: MessageEvent) => void;
    spies.push(get, spyOn(WsClient.prototype, "connect").mockImplementation(() => {}),
      spyOn(WsClient.prototype, "onMessage").mockImplementation((handler) => {
        receive = handler;
        return () => {};
      }));
    const emit = async (data: unknown) => act(async () => {
      receive(new MessageEvent("message", { data: JSON.stringify(data) }));
    });
    function Transcript() {
      const chat = useChat("mobile-startup-session", "claude", "mobile-startup");
      return <div data-loading={chat.messagesLoading}>{chat.messages.map((m) => m.content).join("\n")}</div>;
    }
    view = await mount(<Transcript />);
    expect(historyRequests).toBe(1);
    expect(view.container.firstElementChild?.getAttribute("data-loading")).toBe("true");
    await emit({ type: "session_state", sessionId: "mobile-startup-session", phase: "idle", pendingApproval: null });
    expect(historyRequests).toBe(1);
    await act(async () => initial.resolve({ messages: [{ id: "history", role: "user", content: "Earlier question" }] }));
    expect(view.container.textContent).toContain("Earlier question");
    expect(view.container.firstElementChild?.getAttribute("data-loading")).toBe("false");
    await emit({ type: "phase_changed", phase: "streaming" });
    // The client missed the answer/done frames; idle must recover persisted history.
    await emit({ type: recovery, sessionId: "mobile-startup-session", phase: "idle", pendingApproval: null });
    expect(historyRequests).toBe(2);
    await act(async () => recovered.resolve({ messages: [
      { id: "history", role: "user", content: "Earlier question" },
      { id: "answer", role: "assistant", content: "Recovered answer" },
    ] }));
    expect(view.container.textContent).toContain("Recovered answer");
  });
}

async function typeText(text: string) {
  const textarea = view!.container.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, text);
    textarea.setSelectionRange(text.length, text.length);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("loads slash commands only on first slash and opens the picker when the deferred list arrives", async () => {
  const list = deferred<unknown>();
  const get = spyOn(api, "get").mockImplementation(() => list.promise);
  spies.push(get);
  function Composer() {
    const [items, setItems] = useState<SlashItem[]>([]);
    const [picker, setPicker] = useState({ visible: false, filter: "" });
    return <>
      <MessageInput projectName="mobile-startup" providerId="claude" sessionId="slash-session" onSend={() => {}}
        onSlashItemsLoaded={setItems} onSlashStateChange={(visible, filter) => setPicker({ visible, filter })} />
      <SlashCommandPicker items={items} {...picker} onSelect={() => {}} onClose={() => {}} />
    </>;
  }
  view = await mount(<Composer />);
  expect(get).not.toHaveBeenCalled();
  await typeText("/");
  expect(get).toHaveBeenCalledTimes(1);
  expect(get.mock.calls[0]![0]).toBe("/api/project/mobile-startup/chat/slash-items?providerId=claude&sessionId=slash-session");
  expect(view.container.textContent).not.toContain("Explain this project");
  await act(async () => list.resolve({ items: [{ type: "skill", name: "explain", description: "Explain this project" }], recentNames: [] }));
  expect(view.container.textContent).toContain("Explain this project");
});

it("requests the file index on the first @ interaction, without loading slash commands", async () => {
  useFileStore.setState({ indexStatus: "idle", fileIndex: [] });
  const get = spyOn(api, "get").mockResolvedValue([]);
  spies.push(get);
  view = await mount(<MessageInput projectName="mobile-startup" onSend={() => {}} />);
  expect(get).not.toHaveBeenCalled();
  await typeText("@");
  expect(get).toHaveBeenCalledTimes(1);
  expect(get.mock.calls[0]![0]).toContain("/files/index");
  expect(useFileStore.getState().indexStatus).toBe("ready");
  await typeText("@src");
  expect(get).toHaveBeenCalledTimes(1);
});

it("waits for the resolved provider before loading a slash picker opened during preparation", async () => {
  const get = spyOn(api, "get").mockResolvedValue({ items: [], recentNames: [] });
  spies.push(get);
  let finish!: () => void;
  function Composer() {
    const [pending, setPending] = useState(true);
    finish = () => setPending(false);
    return <MessageInput projectName="mobile-startup" providerId={pending ? "claude" : "codex"}
      configurationPending={pending} onSend={() => {}} />;
  }
  view = await mount(<Composer />);
  await typeText("/");
  expect(get).not.toHaveBeenCalled();
  await act(async () => finish());
  expect(get).toHaveBeenCalledTimes(1);
  expect(get.mock.calls[0]![0]).toContain("providerId=codex");
});
