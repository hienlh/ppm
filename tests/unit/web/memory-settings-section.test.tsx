/**
 * Settings → Memory (requirements 11.1, 11.3, 11.4): the category sits in the AI group after
 * Tools, and the section shows the store's folder and counts, one row per provider with what it
 * copied and its error, the on/off switch (off keeps every file), Sync now, and refetches on
 * `memory:changed`.
 */
import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test";
import { act } from "react";
import { installDom, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom";

installDom();
afterAll(uninstallDom);
const { api } = await import("../../../src/web/lib/api-client");
const { useProjectStore } = await import("../../../src/web/stores/project-store");
const { SETTINGS_CATEGORIES, settingsCategoriesInGroup } = await import("../../../src/web/components/settings/settings-categories");
const { SECTIONS } = await import("../../../src/web/components/settings/settings-section-content");
const { Brain } = await import("../../../src/web/lib/icons");

const twoMinutesAgo = () => new Date(Date.now() - 2 * 60_000).toISOString();

function status(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    root: "/home/me/.ppm/memory",
    counts: { project: 112, global: 4, archived: 3 },
    providers: {
      claude: { count: 110, syncedAt: twoMinutesAgo(), error: null, skipped: [], redacted: 0 },
      codex: { count: 0, syncedAt: twoMinutesAgo(), error: null, skipped: [], redacted: 0 },
      antigravity: { count: 2, syncedAt: twoMinutesAgo(), error: "Cannot read knowledge/k-3f2a/metadata.json", skipped: [], redacted: 0 },
    },
    embedding: { source: "off", model: null, ready: false, reason: "off", vectors: 0, total: 0 },
    ...overrides,
  };
}

let view: Mounted | null = null;
let restore: Array<() => void> = [];
afterEach(async () => {
  await view?.unmount();
  view = null;
  for (const r of restore) r();
  restore = [];
});

interface Calls { gets: string[]; posts: string[]; puts: Array<{ path: string; body: unknown }> }

async function flush() {
  for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); });
}

/** Mounts the section for project `ppm` with the server answering `answer()`; returns the calls. */
async function render(answer: () => unknown = () => status()): Promise<Calls> {
  useProjectStore.setState({ activeProject: { name: "ppm", path: "/tmp/ppm" } as never });
  const calls: Calls = { gets: [], posts: [], puts: [] };
  const get = spyOn(api, "get").mockImplementation(((path: string) => {
    calls.gets.push(path);
    return path.startsWith("/api/memory/status") ? Promise.resolve(answer()) : Promise.reject(new Error("not mocked"));
  }) as never);
  const post = spyOn(api, "post").mockImplementation(((path: string) => {
    calls.posts.push(path);
    return Promise.resolve({ results: [] });
  }) as never);
  const put = spyOn(api, "put").mockImplementation(((path: string, body: unknown) => {
    calls.puts.push({ path, body });
    return Promise.resolve({ enabled: (body as { enabled?: boolean }).enabled ?? true, embedding: { source: "off" } });
  }) as never);
  restore.push(() => get.mockRestore(), () => post.mockRestore(), () => put.mockRestore());
  // A missing section fails as an assertion, not as a load error.
  const mod = await import("../../../src/web/components/settings/memory-settings-section").catch(() => null);
  const MemorySettingsSection = (mod as { MemorySettingsSection?: () => React.ReactNode } | null)?.MemorySettingsSection;
  expect(MemorySettingsSection).toBeDefined();
  const Section = MemorySettingsSection!;
  view = await mount(<Section />);
  await flush();
  return calls;
}

const text = () => view!.container.textContent ?? "";
const providerRow = (id: string) => {
  const row = view!.container.querySelector(`[data-testid="memory-provider-${id}"]`);
  expect(row).not.toBeNull();
  return row as HTMLElement;
};
const button = (label: string) =>
  Array.from(view!.container.querySelectorAll("button")).find((b) => b.textContent?.includes(label)) ?? null;

describe("Settings category", () => {
  it("is memory, in the AI group right after Tools, with the brain icon", () => {
    const ids = settingsCategoriesInGroup("ai").map((c) => c.id);
    expect(ids).toContain("memory");
    expect(ids.indexOf("memory")).toBe(ids.indexOf("tools" as never) + 1);
    const def = SETTINGS_CATEGORIES.find((c) => c.id === ("memory" as never));
    expect(def?.label).toBe("Memory");
    expect(def?.icon).toBe(Brain);
    expect(def?.subtitle.length).toBeGreaterThan(0);
    expect((SECTIONS as Record<string, unknown>).memory).toBeDefined();
  });
});

describe("MemorySettingsSection", () => {
  it("asks for the active project's status and shows the folder and counts", async () => {
    const calls = await render();
    expect(calls.gets[0]).toBe("/api/memory/status?project=ppm");
    expect(text()).toContain("PPM memory");
    expect(text()).toContain("Where memories live");
    expect(text()).toContain("/home/me/.ppm/memory");
    expect(text()).toContain("This project 112 · Global 4 · Archived 3");
    expect(text()).toContain("Copied from providers");
  });

  it("shows one row per provider with its count and last sync", async () => {
    await render();
    expect(providerRow("claude").textContent).toContain("Claude");
    expect(providerRow("claude").textContent).toContain("110 memories");
    expect(providerRow("claude").textContent).toContain("2m ago");
    expect(providerRow("codex").textContent).toContain("Codex");
    expect(providerRow("codex").textContent).toContain("No memories yet");
    expect(providerRow("antigravity").textContent).toContain("Antigravity");
    expect(providerRow("antigravity").textContent).toContain("2 memories");
  });

  it("shows a provider's error in red", async () => {
    await render();
    const red = providerRow("antigravity").querySelector(".text-error");
    expect(red?.textContent).toContain("Cannot read knowledge/k-3f2a/metadata.json");
    expect(providerRow("claude").querySelector(".text-error")).toBeNull();
  });

  it("switching off sends enabled:false and says every file is kept", async () => {
    let enabled = true;
    const calls = await render(() => status({ enabled }));
    const sw = view!.container.querySelector('[role="switch"]');
    expect(sw?.getAttribute("aria-checked")).toBe("true");
    enabled = false;
    await click(sw);
    await flush();
    expect(calls.puts).toEqual([{ path: "/api/memory/settings", body: { enabled: false } }]);
    expect(view!.container.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
    expect(text()).toMatch(/kept/);
  });

  it("Sync now posts to /sync and refreshes the status", async () => {
    let claude = 110;
    const calls = await render(() => {
      const s = status();
      s.providers.claude.count = claude;
      return s;
    });
    const before = calls.gets.length;
    claude = 111;
    await click(button("Sync now"));
    await flush();
    expect(calls.posts).toEqual(["/api/memory/sync"]);
    expect(calls.gets.length).toBeGreaterThan(before);
    expect(providerRow("claude").textContent).toContain("111 memories");
  });

  it("refetches when a memory:changed event arrives", async () => {
    let project = 112;
    const calls = await render(() => status({ counts: { project, global: 4, archived: 3 } }));
    const before = calls.gets.length;
    project = 113;
    await act(async () => {
      window.dispatchEvent(new CustomEvent("memory:changed", { detail: { type: "memory:changed" } }));
    });
    await flush();
    expect(calls.gets.length).toBeGreaterThan(before);
    expect(text()).toContain("This project 113");
  });
});
