import { afterAll, afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { installDom, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom";
import { act } from "react";

installDom();
afterAll(uninstallDom);
const { NewChatProviderGate } = await import("../../../src/web/components/chat/new-chat-provider-gate");
const { usePanelStore } = await import("../../../src/web/stores/panel-store");
const { api } = await import("../../../src/web/lib/api-client");
const settings = { default_provider: "codex", new_chat_provider_mode: "follow-focus",
  providers: { codex: { permission_mode: "plan" }, claude: { permission_mode: "acceptEdits" } } };
let view: Mounted | null = null;
let get: ReturnType<typeof spyOn>;

function Harness() {
  const metadata = usePanelStore((s) => s.panels.main!.tabs[0]!.metadata!);
  return <NewChatProviderGate tabId="new" metadata={metadata}><span>Composer {String(metadata.providerId)}</span></NewChatProviderGate>;
}
beforeEach(() => {
  usePanelStore.setState({ currentProject: "project", focusedPanelId: "main", grid: [["main"]],
    lastFocusedChatProviders: {}, panels: { main: { id: "main", activeTabId: "new", tabHistory: ["new"],
      tabs: [{ id: "new", type: "chat", title: "Chat", projectId: "project", closable: true,
        metadata: { projectName: "project", providerPending: true, focusedProviderOnOpen: "codex" } }] } } });
  get = spyOn(api, "get");
});
afterEach(async () => { await view?.unmount(); view = null; get.mockRestore(); });

it("waits for settings before mounting the composer and applies the selected provider's permissions", async () => {
  let resolve!: (value: unknown) => void;
  get.mockImplementation((path: string) => path === "/api/settings/ai"
    ? new Promise((done) => { resolve = done; }) : Promise.resolve([{ id: "codex", name: "Codex" }]));
  view = await mount(<Harness />);
  expect(view.container.textContent).toContain("Preparing chat");
  expect(view.container.textContent).not.toContain("Composer");
  await act(async () => { resolve(settings); });
  expect(view.container.textContent).toBe("Composer codex");
  expect(usePanelStore.getState().panels.main!.tabs[0]!.metadata!.permissionMode).toBe("plan");
});

it("offers the sole available provider when the selected provider is unavailable", async () => {
  get.mockImplementation((path: string) => Promise.resolve(path === "/api/settings/ai"
    ? settings : [{ id: "claude", name: "Claude" }]));
  view = await mount(<Harness />);
  expect(view.container.textContent).toContain("codex is not available");
  expect(view.container.textContent).not.toContain("Composer");
  await click(view.container.querySelector("button"));
  expect(view.container.textContent).toBe("Composer claude");
  expect(usePanelStore.getState().panels.main!.tabs[0]!.metadata!.permissionMode).toBe("acceptEdits");
});

it("lets the user retry a settings failure without falling back silently", async () => {
  let fail = true;
  get.mockImplementation((path: string) => path === "/api/settings/ai" && fail
    ? Promise.reject(new Error("offline")) : Promise.resolve(path === "/api/settings/ai"
      ? settings : [{ id: "codex", name: "Codex" }]));
  view = await mount(<Harness />);
  expect(view.container.textContent).toContain("Could not load chat settings");
  fail = false;
  await click(view.container.querySelector("button"));
  expect(view.container.textContent).toBe("Composer codex");
});
