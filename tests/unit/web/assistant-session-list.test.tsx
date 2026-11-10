/**
 * The Assistant runs on Claude and Codex only, so its "New" control offers just the ones of
 * those two that are configured, and its list (in Settings) opens a session with a single tap and
 * marks the main one.
 */
import { afterAll, afterEach, expect, it, spyOn } from "bun:test";
import { act } from "react";
import { installDom, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom";

installDom();
afterAll(uninstallDom);
const { AssistantNewSession, AssistantSessionList } = await import("../../../src/web/components/settings/assistant/assistant-session-list");
const { useAssistantProviders } = await import("../../../src/web/hooks/use-assistant-sessions");
const { clearChatPreparationCache } = await import("../../../src/web/lib/chat-preparation-cache");
const { api } = await import("../../../src/web/lib/api-client");

let view: Mounted | null = null;
const spies: Array<{ mockRestore(): void }> = [];
afterEach(async () => {
  await view?.unmount();
  view = null;
  for (const spy of spies.splice(0)) spy.mockRestore();
  clearChatPreparationCache();
});

function Providers() {
  const { providers } = useAssistantProviders();
  return <output>{providers?.map((p) => p.id).join(",") ?? "loading"}</output>;
}

const noop = () => {};

it("offers only the configured providers that can run the Assistant, asked of its own project", async () => {
  const get = spyOn(api, "get").mockResolvedValue([
    { id: "claude", name: "Claude", supportsAssistantSessions: true },
    { id: "cursor", name: "Cursor", supportsAssistantSessions: true },
    { id: "codex", name: "Codex", supportsAssistantSessions: true },
  ] as never);
  spies.push(get);
  view = await mount(<Providers />);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(view.container.querySelector("output")!.textContent).toBe("claude,codex");
  expect(String(get.mock.calls[0]![0])).toBe("/api/project/__assistant__/chat/providers");
});

it("leaves out a provider the server does not say can run the Assistant", async () => {
  const get = spyOn(api, "get").mockResolvedValue([
    { id: "claude", name: "Claude", supportsAssistantSessions: true },
    { id: "codex", name: "Codex", supportsAssistantSessions: false },
  ] as never);
  view = await mount(<Providers />);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(view.container.querySelector("output")!.textContent).toBe("claude");
  await view.unmount();
  get.mockRestore();
  clearChatPreparationCache();
  // An older server's list carries no capability at all: nothing is offered.
  spies.push(spyOn(api, "get").mockResolvedValue([{ id: "claude", name: "Claude" }] as never));
  view = await mount(<Providers />);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(view.container.querySelector("output")!.textContent).toBe("");
});

it("starts a session on the provider whose button was pressed", async () => {
  const picked: string[] = [];
  view = await mount(<AssistantNewSession providers={[{ id: "claude", name: "Claude" }, { id: "codex", name: "Codex" }]}
    onNew={(id) => picked.push(id)} />);
  const buttons = [...view.container.querySelectorAll("button")];
  expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
    "New Assistant session with Claude", "New Assistant session with Codex",
  ]);
  for (const b of buttons) expect(b.className).toContain("min-h-11");
  await click(buttons[1]!);
  expect(picked).toEqual(["codex"]);
});

it("lists the sessions, marks the main one, and opens one with a tap", async () => {
  spies.push(spyOn(api, "get").mockRejectedValue(new Error("no Telegram here") as never));
  const opened: string[] = [];
  const sessions = [
    { id: "s1", providerId: "claude", title: "Find the failing chat", createdAt: "2026-10-09T01:00:00Z" },
    { id: "s2", providerId: "codex", title: "Query orders", createdAt: "2026-10-09T02:00:00Z" },
    { id: "s3", providerId: "cursor", title: "Not an Assistant provider", createdAt: "2026-10-09T03:00:00Z" },
  ];
  view = await mount(<AssistantSessionList sessions={sessions} mainSessionId="s1"
    onOpen={(s) => opened.push(s.id)} onSetMain={noop} onDelete={noop} />);
  const rows = [...view.container.querySelectorAll("li button")];
  expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining("Find the failing chat"), expect.stringContaining("Query orders")]);
  expect(rows[0]!.getAttribute("aria-current")).toBe("true");
  expect(rows[0]!.querySelector("[data-testid=assistant-session-main]")?.textContent).toBe("Main");
  expect(rows[1]!.querySelector("[data-testid=assistant-session-main]")).toBeNull();
  await click(rows[1]!);
  expect(opened).toEqual(["s2"]);
});

it("says so when there are no sessions yet", async () => {
  view = await mount(<AssistantSessionList sessions={[]} mainSessionId={null} onOpen={noop} onSetMain={noop} onDelete={noop} />);
  expect(view.container.textContent).toContain("No Assistant sessions yet.");
});
