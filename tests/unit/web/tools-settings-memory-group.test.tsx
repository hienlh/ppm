/**
 * Settings → Tools → Memory (requirement 7.8): the memory tools' own group, last, with the intro,
 * labels and notes as drawn, one switch per tool reflecting `ai.ppm_tools`.
 */
import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test";
import { act } from "react";
import { installDom, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom";

installDom();
afterAll(uninstallDom);
const { ToolsSettingsSection } = await import("../../../src/web/components/settings/tools-settings-section");
const { api } = await import("../../../src/web/lib/api-client");

const ROWS = [
  { tool: "memory_search", label: "Search memory", note: "Finds memories by words and meaning; answers names and one-line descriptions only." },
  { tool: "memory_read", label: "Read memory", note: "Reads one memory in full." },
  { tool: "memory_write", label: "Save memory", note: "Creates or updates a PPM memory. A memory copied from a provider cannot be changed here." },
  { tool: "memory_forget", label: "Forget memory", note: "Archives a PPM memory. The file is kept." },
] as const;

let view: Mounted | null = null;
let restore: Array<() => void> = [];
afterEach(async () => {
  await view?.unmount();
  view = null;
  for (const r of restore) r();
  restore = [];
});

/** Mounts the section with these stored switches; returns the PUT bodies it sends. */
async function render(ppmTools: Record<string, boolean>): Promise<unknown[]> {
  const settings = { default_provider: "claude", providers: {}, ppm_tools: ppmTools };
  const puts: unknown[] = [];
  const get = spyOn(api, "get").mockImplementation(((path: string) =>
    path === "/api/settings/ai" ? Promise.resolve(settings) : Promise.reject(new Error("not mocked"))) as never);
  const put = spyOn(api, "put").mockImplementation(((_path: string, body: unknown) => {
    puts.push(body);
    return Promise.resolve(settings);
  }) as never);
  restore.push(() => get.mockRestore(), () => put.mockRestore());
  view = await mount(<ToolsSettingsSection />);
  await act(async () => { await Promise.resolve(); });
  return puts;
}

const sections = () => Array.from(view!.container.querySelectorAll("section"));
const memorySection = () => sections().find((s) => s.querySelector("h3")?.textContent === "Memory");
/** The Memory group, asserted present, so a missing group fails as an assertion. */
function memory(): HTMLElement {
  const section = memorySection();
  expect(section).toBeDefined();
  return section!;
}

/** The row of one tool: the label holding its `<code>` name, and the switch beside it. */
function row(tool: string) {
  const code = Array.from(memory().querySelectorAll("code")).find((c) => c.textContent === tool);
  expect(code).toBeDefined();
  const label = code!.closest("label")!;
  const sw = label.parentElement!.querySelector('[role="switch"]')!;
  return { label, sw };
}

describe("ToolsSettingsSection: the Memory group", () => {
  it("is the last group, titled Memory, with its intro", async () => {
    await render({});
    const memory = memorySection();
    expect(memory).toBeDefined();
    expect(sections().at(-1)).toBe(memory!);
    expect(memory!.textContent).toContain("PPM's memory store, shared by Claude, Codex and Antigravity.");
  });

  it("lists the four memory tools with their labels and notes, in order", async () => {
    await render({});
    const codes = Array.from(memory().querySelectorAll("code")).map((c) => c.textContent);
    expect(codes).toEqual(ROWS.map((r) => r.tool));
    for (const { tool, label, note } of ROWS) {
      const text = row(tool).label.textContent ?? "";
      expect(text).toContain(label);
      expect(text).toContain(note);
    }
  });

  it("each switch reflects its stored switch", async () => {
    await render({ memory_search: true, memory_read: true, memory_write: true, memory_forget: false });
    expect(ROWS.map((r) => row(r.tool).sw.getAttribute("aria-checked"))).toEqual(["true", "true", "true", "false"]);
  });

  it("all four are off until the feature is answered", async () => {
    await render({});
    expect(ROWS.map((r) => row(r.tool).sw.getAttribute("aria-checked"))).toEqual(["false", "false", "false", "false"]);
  });

  it("turning one on saves that switch", async () => {
    const puts = await render({ memory_search: true, memory_read: true, memory_write: true, memory_forget: false });
    await click(row("memory_forget").sw);
    expect(puts).toEqual([{ ppm_tools: { memory_forget: true } }]);
  });
});
