import { afterAll, afterEach, expect, it, spyOn } from "bun:test";
import { act } from "react";
import { installDom, uninstallDom, mount, type Mounted } from "../../helpers/react-dom";

installDom();
afterAll(uninstallDom);
const { useChat } = await import("../../../src/web/hooks/use-chat");
const { api } = await import("../../../src/web/lib/api-client");
const { WsClient } = await import("../../../src/web/lib/ws-client");
let view: Mounted | null = null;
const spies: Array<{ mockRestore(): void }> = [];
afterEach(async () => {
  await view?.unmount();
  view = null;
  for (const spy of spies.splice(0)) spy.mockRestore();
});

async function setup(messages: unknown[] = []) {
  let receive!: (event: MessageEvent) => void;
  spies.push(spyOn(api, "get").mockImplementation((path: string) =>
    Promise.resolve(path === "/api/teams" ? [] : { messages }) as any),
  spyOn(WsClient.prototype, "connect").mockImplementation(() => {}),
  spyOn(WsClient.prototype, "onMessage").mockImplementation(handler => {
    receive = handler;
    return () => {};
  }));
  function Transcript() {
    const chat = useChat("background-session", "codex", "background-test");
    return <pre data-phase={chat.phase}>{JSON.stringify(chat.messages)}</pre>;
  }
  view = await mount(<Transcript />);
  return async (data: unknown) => act(async () => {
    receive(new MessageEvent("message", { data: JSON.stringify(data) }));
    await new Promise(resolve => setTimeout(resolve, 120));
  });
}

it("keeps reloaded history visible when a background agent finishes after the root", async () => {
  const emit = await setup([
    { id: "question", role: "user", content: "Do the work" },
    { id: "rollout-2", role: "assistant", content: "Finished answer", events: [
      { type: "tool_use", tool: "Agent", toolUseId: "subagent-child", input: {} },
      { type: "text", content: "Finished answer" },
    ] },
  ]);
  await emit({ type: "session_state", sessionId: "background-session", phase: "idle" });
  await emit({ type: "tool_result", toolUseId: "subagent-child", output: "Child finished" });
  const messages = JSON.parse(view!.container.textContent!);
  expect(messages).toHaveLength(2);
  expect(messages[1].content).toBe("Finished answer");
  expect(messages[1].events[0].result.output).toBe("Child finished");
  expect(view!.container.firstElementChild?.getAttribute("data-phase")).toBe("idle");
  await emit({ type: "error", parentToolUseId: "subagent-child", message: "Child failed" });
  const afterError = JSON.parse(view!.container.textContent!);
  expect(afterError[1].content).toBe("Finished answer");
  expect(afterError[1].events).toHaveLength(2);
  // An "error" child is neither a nested Agent/Task stub nor a file mutation, so slimming
  // routes it into the card's ring-buffer fallback instead of the kept `children` — the
  // change tray and nested routing never needed it, only a human reading the card does.
  expect(afterError[1].events[0].children ?? []).toHaveLength(0);
  expect(afterError[1].events[0].recentChildren[0].message).toBe("Child failed");
});

it("does not finalize root text when a nested done arrives", async () => {
  const emit = await setup();
  await emit({ type: "session_state", sessionId: "background-session", phase: "streaming" });
  await emit({ type: "text", content: "Before " });
  await emit({ type: "done", parentToolUseId: "subagent-child" });
  await emit({ type: "text", content: "after" });
  await emit({ type: "done" });
  const messages = JSON.parse(view!.container.textContent!);
  expect(messages).toHaveLength(1);
  expect(messages[0].content).toBe("Before after");
});
