import { afterAll, afterEach, expect, it, spyOn } from "bun:test";
import { installDom, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom";

installDom();
afterAll(uninstallDom);
const { act, useState } = await import("react");
const { api } = await import("../../../src/web/lib/api-client");
const { useUsage } = await import("../../../src/web/hooks/use-usage");
const { ModelThinkingSelector } = await import("../../../src/web/components/chat/model-thinking-selector");
let view: Mounted | undefined;
let restore: (() => void) | undefined;
afterEach(async () => { await view?.unmount(); restore?.(); });
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

it("shows cached recent history immediately while deferring its refresh and tags", async () => {
  const { SessionListPanel } = await import("../../../src/web/components/chat/session-list-panel");
  const spy = spyOn(api, "get").mockImplementation((async (url: string) => url.endsWith("/tags")
    ? { tags: [], counts: {} }
    : { sessions: [{ id: "recent", title: "Remembered chat", providerId: "claude" }], hasMore: false }) as typeof api.get);
  restore = () => spy.mockRestore();
  view = await mount(<SessionListPanel projectName="lazy-history" onSelectSession={() => {}} />);
  expect(spy).not.toHaveBeenCalled();
  await settleDelay();
  expect(view.container.textContent).toContain("Remembered chat");
  expect(spy.mock.calls.filter(([url]) => String(url).includes("/chat/sessions"))).toHaveLength(1);
  await view.unmount();
  spy.mockClear();
  view = await mount(<SessionListPanel projectName="lazy-history" onSelectSession={() => {}} />);
  expect(view.container.textContent).toContain("Remembered chat");
  expect(spy).not.toHaveBeenCalled();
  await view.unmount();
  view = await mount(<SessionListPanel projectName="different-history" onSelectSession={() => {}} />);
  expect(view.container.textContent).not.toContain("Remembered chat");
  expect(spy).not.toHaveBeenCalled();
});
