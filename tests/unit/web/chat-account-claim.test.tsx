import { afterAll, afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { act } from "react";
import { installDom, uninstallDom, mount, type Mounted } from "../../helpers/react-dom";

installDom();
afterAll(uninstallDom);
const { useChatAccountClaim } = await import("../../../src/web/hooks/use-chat-account-claim");
const { usePanelStore } = await import("../../../src/web/stores/panel-store");
const { patchTabMetadata } = await import("../../../src/web/lib/patch-tab-metadata");
const { api } = await import("../../../src/web/lib/api-client");
let view: Mounted | null = null;
let post: ReturnType<typeof spyOn>;
let claim: ReturnType<typeof useChatAccountClaim>;
function metadata() { return usePanelStore.getState().panels.main!.tabs[0]!.metadata!; }
function Harness() {
  const current = usePanelStore((state) => state.panels.main!.tabs[0]!.metadata!);
  claim = useChatAccountClaim("claim-test", current.providerId as string, true);
  return <span>{String(current.pickedAccountId ?? "")}</span>;
}
beforeEach(() => {
  usePanelStore.setState({ currentProject: "test", focusedPanelId: "main", grid: [["main"]],
    lastFocusedChatProviders: {}, panels: { main: { id: "main", activeTabId: "claim-test", tabHistory: ["claim-test"],
      tabs: [{ id: "claim-test", type: "chat", title: "Chat", projectId: "test", closable: true,
        metadata: { projectName: "test", providerId: "claude" } }] } } });
  post = spyOn(api, "post").mockImplementation((path: string) => Promise.resolve(
    path === "/api/codex-accounts/pick" ? { id: "codex-original", label: "Codex original" }
      : { id: "claude-original", label: "Claude original" }));
});
afterEach(async () => { await view?.unmount(); view = null; post.mockRestore(); });

it("republishes the original claim after A to B to A with only two account picks", async () => {
  view = await mount(<Harness />);
  expect(metadata().pickedAccountId).toBe("claude-original");
  await act(async () => { patchTabMetadata("claim-test", { providerId: "codex" }); });
  expect(metadata().pickedAccountId).toBe("codex-original");
  await act(async () => { patchTabMetadata("claim-test", { providerId: "claude" }); });
  expect(metadata()).toMatchObject({ pickedAccountProvider: "claude", pickedAccountId: "claude-original", pickedAccountLabel: "Claude original" });
  expect(await claim("claude")).toEqual({ id: "claude-original", label: "Claude original" });
  expect(post).toHaveBeenCalledTimes(2);
});

it("preserves a manual same-provider choice while a cached claim is reapplied", async () => {
  view = await mount(<Harness />);
  await act(async () => { patchTabMetadata("claim-test", { providerId: "codex" }); });
  await act(async () => {
    patchTabMetadata("claim-test", { providerId: "claude" });
    const cached = claim("claude");
    patchTabMetadata("claim-test", { pickedAccountProvider: "claude", pickedAccountId: "manual-account", pickedAccountLabel: "Manual" });
    await cached;
  });
  expect(metadata()).toMatchObject({ pickedAccountProvider: "claude", pickedAccountId: "manual-account", pickedAccountLabel: "Manual" });
  expect(await claim("claude")).toEqual({ id: "manual-account", label: "Manual" });
  expect(post).toHaveBeenCalledTimes(2);
});

it("preserves a manual same-provider choice when the first account pick resolves late", async () => {
  let resolve!: (value: unknown) => void;
  post.mockImplementation(() => new Promise((done) => { resolve = done; }));
  view = await mount(<Harness />);
  await act(async () => {
    patchTabMetadata("claim-test", { pickedAccountProvider: "claude", pickedAccountId: "manual-account", pickedAccountLabel: "Manual" });
    resolve({ id: "claude-original", label: "Claude original" });
  });
  expect(metadata().pickedAccountId).toBe("manual-account");
  expect(await claim("claude")).toEqual({ id: "manual-account", label: "Manual" });
  expect(post).toHaveBeenCalledTimes(1);
});
