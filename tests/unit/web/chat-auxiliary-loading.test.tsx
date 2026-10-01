import { afterAll, afterEach, expect, it, spyOn } from "bun:test";
import { installDom, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom";

installDom();
afterAll(uninstallDom);
const { act, useState } = await import("react");
const { api } = await import("../../../src/web/lib/api-client");
const { useUsage } = await import("../../../src/web/hooks/use-usage");
const { startPrepare, __clearPrepareForTest } = await import("../../../src/web/lib/new-chat-prepare-client");
const { ModelThinkingSelector } = await import("../../../src/web/components/chat/model-thinking-selector");
let view: Mounted | undefined;
let restore: (() => void) | undefined;
afterEach(async () => { await view?.unmount(); restore?.(); __clearPrepareForTest(); localStorage.clear(); });
const settleDelay = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 550)); });

it("shows the configured model without discovery until the picker opens", async () => {
  const spy = spyOn(api, "get").mockResolvedValue([{ value: "opus", label: "Claude Opus" }]);
  restore = () => spy.mockRestore();
  view = await mount(<ModelThinkingSelector projectName="lazy-model" providerId="claude" model="opus"
    effort={null} thinking={false} onModelChange={() => {}} onEffortChange={() => {}} onThinkingChange={() => {}} />);
  expect(spy).not.toHaveBeenCalled();
  expect(view.container.textContent).toContain("opus");
  expect(view.container.textContent).not.toContain("Loading");
  await click(view.container.querySelector("button"));
  expect(spy).toHaveBeenCalledTimes(1);
  expect(view.container.textContent).toContain("Opus");
});

it("waits for enabled and the initial delay, reuses only the exact account snapshot", async () => {
  const spy = spyOn(api, "get").mockImplementation((async (url: string) => ({ activeAccountId: url.includes("accountId=b") ? "b" : "a", sevenDay: 0.42 })) as typeof api.get);
  restore = () => spy.mockRestore();
  let setEnabled!: (value: boolean) => void;
  let setAccount!: (value: string) => void;
  function Harness() {
    const [enabled, updateEnabled] = useState(false);
    const [account, updateAccount] = useState("a");
    setEnabled = updateEnabled;
    setAccount = updateAccount;
    const usage = useUsage("lazy-usage", "codex", undefined, account, enabled);
    return <div>{usage.usageInfo.activeAccountId ?? "empty"}</div>;
  }
  view = await mount(<Harness />);
  await settleDelay();
  expect(spy).not.toHaveBeenCalled();
  await act(async () => { setEnabled(true); });
  expect(spy).not.toHaveBeenCalled();
  await settleDelay();
  expect(view.container.textContent).toBe("a");
  await act(async () => { setAccount("b"); });
  expect(view.container.textContent).toBe("empty");
  await settleDelay();
  expect(view.container.textContent).toBe("b");
  await act(async () => { setAccount("a"); });
  expect(view.container.textContent).toBe("a");
  expect(spy).toHaveBeenCalledTimes(2);
});

it("defers the initial usage read until the tab's own prepare settles, then fetches when it carried no usage", async () => {
  const spy = spyOn(api, "get").mockResolvedValue({ activeAccountId: "fetched" });
  restore = () => spy.mockRestore();
  const post = spyOn(api, "post").mockResolvedValue({
    resolvedProviderId: "claude", providerId: "claude",
    settings: { default_provider: "claude", providers: {} }, providers: [],
    pickedAccount: null, usage: null, draft: null, tags: null, slash: { items: [], recentNames: [] },
  });
  startPrepare("usage-tab", { name: "usage-defer", path: "usage-defer" }, { providerId: "claude" });
  function Harness() {
    const usage = useUsage("usage-defer", "claude", undefined, undefined, true, "usage-tab");
    return <div>{usage.usageInfo.activeAccountId ?? "empty"}</div>;
  }
  view = await mount(<Harness />);
  expect(spy).not.toHaveBeenCalled();
  await settleDelay();
  expect(spy).toHaveBeenCalledTimes(1);
  expect(view.container.textContent).toBe("fetched");
  post.mockRestore();
});

it("skips its own fetch when the tab's own prepare already seeded a fresh usage snapshot", async () => {
  const spy = spyOn(api, "get");
  restore = () => spy.mockRestore();
  const post = spyOn(api, "post").mockResolvedValue({
    resolvedProviderId: "claude", providerId: "claude",
    settings: { default_provider: "claude", providers: {} }, providers: [],
    pickedAccount: { id: "picked", label: null },
    usage: { activeAccountId: "picked", sevenDay: 0.5 },
    draft: null, tags: null, slash: { items: [], recentNames: [] },
  });
  startPrepare("usage-tab-2", { name: "usage-seeded", path: "usage-seeded" }, { providerId: "claude" });
  function Harness() {
    const usage = useUsage("usage-seeded", "claude", undefined, "picked", true, "usage-tab-2");
    return <div>{usage.usageInfo.activeAccountId ?? "empty"}</div>;
  }
  view = await mount(<Harness />);
  await settleDelay();
  expect(spy).not.toHaveBeenCalled();
  expect(view.container.textContent).toBe("picked");
  post.mockRestore();
});

it("cancels the delayed usage read on unmount", async () => {
  const spy = spyOn(api, "get").mockResolvedValue({});
  restore = () => spy.mockRestore();
  function Harness() { useUsage("cancel-usage"); return null; }
  view = await mount(<Harness />);
  await view.unmount();
  view = undefined;
  await settleDelay();
  expect(spy).not.toHaveBeenCalled();
});

it("does not cache or display another account's returned quota under the selected account", async () => {
  const spy = spyOn(api, "get").mockResolvedValue({ activeAccountId: "different", sevenDay: 0.99 });
  restore = () => spy.mockRestore();
  function Harness() {
    const usage = useUsage("account-mismatch", "claude", "session", "selected");
    return <div>{JSON.stringify(usage.usageInfo)}</div>;
  }
  view = await mount(<Harness />);
  await settleDelay();
  expect(view.container.textContent).toBe("{}");
});

it("keeps the provider picker accessible before discovering its list", async () => {
  const { ProviderSelector } = await import("../../../src/web/components/chat/provider-selector");
  const spy = spyOn(api, "get").mockResolvedValue([{ id: "claude", name: "Claude" }, { id: "codex", name: "Codex" }]);
  restore = () => spy.mockRestore();
  view = await mount(<ProviderSelector projectName="lazy-provider-picker" value="claude" onChange={() => {}} />);
  expect(spy).not.toHaveBeenCalled();
  await click(view.container.querySelector("button"));
  expect(spy).toHaveBeenCalledTimes(1);
  expect(view.container.textContent).toContain("Codex");
});

it("shows cached recent history immediately, syncing once through the shared store (no artificial delay)", async () => {
  const { SessionListPanel } = await import("../../../src/web/components/chat/session-list-panel");
  const { useSessionListStore } = await import("../../../src/web/stores/session-list-store");
  useSessionListStore.setState({ byProject: {} });
  const spy = spyOn(api, "get").mockImplementation((async (url: string) => {
    if (url.endsWith("/tags")) return { tags: [], counts: {}, defaultTagId: null };
    // Distinguish the two projects by URL, so the final assertion proves
    // per-project cache isolation rather than depending on fetch timing.
    if (!url.includes("session-panel-cache-demo-other") && url.includes("session-panel-cache-demo")) {
      return { sessions: [{ id: "recent", title: "Remembered chat", providerId: "claude", createdAt: "2026-01-01T00:00:00.000Z" }], hasMore: false };
    }
    return { sessions: [], hasMore: false };
  }) as typeof api.get);
  restore = () => spy.mockRestore();
  view = await mount(<SessionListPanel projectName="session-panel-cache-demo" onSelectSession={() => {}} />);
  await settleDelay();
  expect(view.container.textContent).toContain("Remembered chat");
  // One shared sync for the whole project — not one fetch per reader.
  expect(spy.mock.calls.filter(([url]) => String(url).includes("/chat/sessions"))).toHaveLength(1);
  await view.unmount();
  spy.mockClear();
  // Synced under 15s ago — remounting the same project reads the store, no refetch.
  view = await mount(<SessionListPanel projectName="session-panel-cache-demo" onSelectSession={() => {}} />);
  expect(view.container.textContent).toContain("Remembered chat");
  expect(spy).not.toHaveBeenCalled();
  await view.unmount();
  view = await mount(<SessionListPanel projectName="session-panel-cache-demo-other" onSelectSession={() => {}} />);
  expect(view.container.textContent).not.toContain("Remembered chat");
});
