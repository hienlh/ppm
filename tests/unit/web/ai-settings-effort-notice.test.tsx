/**
 * Settings → AI Provider's default Effort is inert for every project while a global
 * `CLAUDE_CODE_EFFORT_LEVEL` is set, and the pane has to say so under the select.
 */
import { afterAll, afterEach, expect, it, spyOn } from "bun:test";
import { act } from "react";
import { installDom, uninstallDom, installGlobal, mount, type Mounted } from "../../helpers/react-dom";
import type { EffortStatus } from "../../../src/shared/effort-status";

installDom();
// Radix's Select builds its portal content in one.
installGlobal("DocumentFragment", window.DocumentFragment);
afterAll(uninstallDom);
const { api } = await import("../../../src/web/lib/api-client");
const { AISettingsSection } = await import("../../../src/web/components/settings/ai-settings-section");

let view: Mounted | null = null;
const spies: Array<{ mockRestore(): void }> = [];
afterEach(async () => {
  await view?.unmount();
  view = null;
  for (const spy of spies.splice(0)) spy.mockRestore();
});

async function render(status: EffortStatus | null) {
  const asked: string[] = [];
  spies.push(spyOn(api, "get").mockImplementation(((path: string) => {
    if (path === "/api/settings/ai") {
      return Promise.resolve({ default_provider: "claude", providers: { claude: { type: "agent-sdk", model: "claude-opus-5-5", effort: "high" } } });
    }
    if (path.includes("/effort-status")) { asked.push(path); return Promise.resolve({ status }); }
    return Promise.resolve([]);
  }) as typeof api.get));
  view = await mount(<AISettingsSection />);
  await act(async () => { await Bun.sleep(10); });
  return asked;
}

const notice = () => [...view!.container.querySelectorAll('[role="note"]')].find((n) => n.textContent?.includes("Effort"));

it("says under the default Effort that a variable set outside PPM overrides it", async () => {
  const asked = await render({ env: { value: "max", source: "userSettings", file: "~/.claude/settings.json" } });
  expect(asked.at(-1)).toBe("/api/settings/ai/providers/claude/effort-status?model=claude-opus-5-5");
  expect(notice()?.textContent).toContain("Effort is set to Max outside PPM");
  expect(notice()?.textContent).toContain("CLAUDE_CODE_EFFORT_LEVEL=max in ~/.claude/settings.json");
});

it("says nothing when nothing overrides it", async () => {
  await render({});
  expect(notice()).toBeUndefined();
  await view!.unmount();
  for (const spy of spies.splice(0)) spy.mockRestore();
  await render(null);
  expect(notice()).toBeUndefined();
});
