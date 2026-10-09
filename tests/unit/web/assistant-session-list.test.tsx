/**
 * The Assistant runs on Claude and Codex only, so its "New" control offers just the ones of
 * those two that are configured, and its list picks a session with a single tap.
 */
import { afterAll, afterEach, expect, it, spyOn } from "bun:test";
import { act } from "react";
import { installDom, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom";

installDom();
afterAll(uninstallDom);
const { AssistantNewSession, AssistantSessionList, useAssistantProviders } = await import("../../../src/web/components/assistant/assistant-session-list");
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

it("offers only the configured providers that can run the Assistant, asked of its own project", async () => {
  const get = spyOn(api, "get").mockResolvedValue([
    { id: "claude", name: "Claude" }, { id: "cursor", name: "Cursor" }, { id: "codex", name: "Codex" },
  ] as never);
  spies.push(get);
  view = await mount(<Providers />);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(view.container.querySelector("output")!.textContent).toBe("claude,codex");
  expect(String(get.mock.calls[0]![0])).toBe("/api/project/__assistant__/chat/providers");
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

it("lists the sessions, marks the open one, and picks one with a tap", async () => {
  const chosen: string[] = [];
  const sessions = [
    { id: "s1", providerId: "claude", title: "Find the failing chat", createdAt: "2026-10-09T01:00:00Z" },
    { id: "s2", providerId: "codex", title: "Query orders", createdAt: "2026-10-09T02:00:00Z" },
    { id: "s3", providerId: "cursor", title: "Not an Assistant provider", createdAt: "2026-10-09T03:00:00Z" },
  ];
  view = await mount(<AssistantSessionList sessions={sessions} activeSessionId="s2" onSelect={(s) => chosen.push(s.id)} />);
  const rows = [...view.container.querySelectorAll("li button")];
  expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining("Find the failing chat"), expect.stringContaining("Query orders")]);
  expect(rows[1]!.getAttribute("aria-current")).toBe("true");
  await click(rows[0]!);
  expect(chosen).toEqual(["s1"]);
});

it("says so when there are no sessions yet", async () => {
  view = await mount(<AssistantSessionList sessions={[]} activeSessionId={null} onSelect={() => {}} />);
  expect(view.container.textContent).toContain("No Assistant sessions yet.");
});
