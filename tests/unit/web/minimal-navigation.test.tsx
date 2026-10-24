import { afterAll, afterEach, expect, test } from "bun:test";
import { installDom, uninstallDom, mount, click, installGlobal } from "../../helpers/react-dom";

installDom();
afterAll(uninstallDom);
const React = await import("react");
const { Sidebar } = await import("../../../src/web/components/layout/sidebar");
const { MobileNav } = await import("../../../src/web/components/layout/mobile-nav");
const { MobileDrawer } = await import("../../../src/web/components/layout/mobile-drawer");
const { useSettingsStore } = await import("../../../src/web/stores/settings-store");
const { useProjectStore } = await import("../../../src/web/stores/project-store");
const { usePanelStore } = await import("../../../src/web/stores/panel-store");
const { TooltipProvider } = await import("../../../src/web/components/ui/tooltip");
const { useWindowStore } = await import("../../../src/web/components/floating-window/window-store");
const settings = useSettingsStore.getState();
afterEach(() => useSettingsStore.setState(settings));

function setup() {
  const requests: string[] = [];
  installGlobal("fetch", async (url: string) => {
    requests.push(String(url));
    return new Response(JSON.stringify({ ok: true, data: [] }));
  });
  useSettingsStore.setState({ minimalMode: true, sidebarActiveTab: "explorer", sidebarCollapsed: false, logsBadge: true });
  useProjectStore.setState({ projects: [], activeProject: null });
  usePanelStore.setState({ currentProject: "__global__", focusedPanelId: "left", grid: [["left"]],
    panels: { left: { id: "left", tabs: [{ id: "editor:a", type: "editor", title: "a", closable: true, projectId: null }], activeTabId: "editor:a", tabHistory: [] } },
    dock: { visible: true, height: 30 },
  });
  return requests;
}

test("minimal sidebar keeps explorer and switches to history without exposing disabled utilities", async () => {
  const requests = setup();
  const rendered = await mount(<TooltipProvider><Sidebar /></TooltipProvider>);
  try {
    expect(rendered.container.querySelector("aside")).not.toBeNull();
    expect(rendered.container.textContent).toContain("Select a project to browse files");
    const history = [...rendered.container.querySelectorAll("button")].find((button) => button.textContent === "Chat History");
    await click(history!);
    expect(rendered.container.textContent).toContain("Select a project to view chat history");
    expect(rendered.container.querySelector('[aria-label="Settings"]')).not.toBeNull();
    await click(rendered.container.querySelector('[aria-label="Settings"]'));
    expect(Object.values(useWindowStore.getState().windows).some((win) => win.kind === "settings")).toBe(true);
    expect(rendered.container.querySelector('[aria-label="File Explorer"]')).toBeNull();
    expect(useSettingsStore.getState().sidebarActiveTab).toBe("history");
    expect(useSettingsStore.getState().sidebarCollapsed).toBe(false);
    expect(requests.filter((url) => /android|remote-desktop|logs|\/git/.test(url))).toEqual([]);
  } finally { await rendered.unmount(); }
});

test("minimal mobile navigation retains its bottom bar and plus button while hiding terminal", async () => {
  setup();
  const rendered = await mount(<TooltipProvider><MobileNav onMenuPress={() => {}} onProjectsPress={() => {}} /></TooltipProvider>);
  try {
    expect(rendered.container.querySelector('nav')?.className).toContain("fixed bottom-0");
    expect(rendered.container.querySelector('[aria-label="Open menu"]')).not.toBeNull();
    expect(rendered.container.querySelector('[aria-label="Hide panel"]')).toBeNull();
    await click(rendered.container.querySelector('[aria-label="New tab"]'));
    const tabs = usePanelStore.getState().panels.left!.tabs;
    expect(tabs.some((tab) => tab.type === "chat")).toBe(true);
    expect(tabs.some((tab) => tab.id === "editor:a")).toBe(true);
  } finally { await rendered.unmount(); }
});

test("minimal mobile drawer falls back from database and allows explorer and search in its original drawer", async () => {
  const requests = setup();
  const rendered = await mount(<TooltipProvider><MobileDrawer isOpen onClose={() => {}} initialTab="database" /></TooltipProvider>);
  try {
    expect(rendered.container.querySelector('[data-tabid="history"]')).not.toBeNull();
    expect(rendered.container.querySelector('[data-tabid="explorer"]')).not.toBeNull();
    expect(rendered.container.querySelector('[data-tabid="search"]')).not.toBeNull();
    await click(rendered.container.querySelector('[data-tabid="explorer"]'));
    expect(rendered.container.querySelector('[data-onboarding="explorer"]')).not.toBeNull();
    expect(rendered.container.querySelector('[data-tabid="database"]')).toBeNull();
    expect(rendered.container.textContent).toContain("Settings");
    expect(requests.filter((url) => /android|remote-desktop|logs|\/db/.test(url))).toEqual([]);
  } finally { await rendered.unmount(); }
});

test("minimal sidebar preserves an unavailable saved section while showing history", async () => {
  setup();
  useSettingsStore.setState({ sidebarActiveTab: "database" });
  const rendered = await mount(<TooltipProvider><Sidebar /></TooltipProvider>);
  try {
    expect(rendered.container.textContent).toContain("Select a project to view chat history");
    expect(useSettingsStore.getState().sidebarActiveTab).toBe("database");
    expect(rendered.container.textContent).not.toContain("Database");
  } finally { await rendered.unmount(); }
});
