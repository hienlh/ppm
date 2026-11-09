import { afterAll, afterEach, expect, it, spyOn } from "bun:test";
import { installDom, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom";
import type { EffortStatus } from "../../../src/shared/effort-status";

installDom();
afterAll(uninstallDom);
const { api } = await import("../../../src/web/lib/api-client");
const { ModelThinkingSelector } = await import("../../../src/web/components/chat/model-thinking-selector");
let view: Mounted | undefined;
let restore: (() => void) | undefined;
afterEach(async () => { await view?.unmount(); restore?.(); });

// What the CLI answered for a user with `"env": { "CLAUDE_CODE_EFFORT_LEVEL": "max" }` in ~/.claude/settings.json.
const globalMax: EffortStatus = {
  env: { value: "max", source: "userSettings", file: "~/.claude/settings.json" },
  observed: { requested: "high", applied: "max", model: "claude-opus-5-5[1m]" },
};

async function render(effortStatus: EffortStatus | null) {
  const spy = spyOn(api, "get").mockResolvedValue([{ value: "claude-opus-5-5", label: "Claude Opus 5.5" }] as never);
  restore = () => spy.mockRestore();
  view = await mount(<ModelThinkingSelector model="claude-opus-5-5" effort="high" effortStatus={effortStatus} thinking={false}
    onModelChange={() => {}} onEffortChange={() => {}} onThinkingChange={() => {}} projectName="demo" providerId="claude" />);
  return view.container;
}

const effortRow = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.startsWith(label) && !b.textContent.includes("·"));

it("shows the effort that runs, flags the override, and says where it is set", async () => {
  const container = await render(globalMax);
  const chip = container.querySelector("button")!;
  expect(chip.textContent).toBe("Opus 5.5 · Max");
  expect(chip.getAttribute("title")).toContain("CLAUDE_CODE_EFFORT_LEVEL=max in ~/.claude/settings.json");
  expect(chip.getAttribute("aria-label")).toContain("effort Max (Effort is set to Max outside PPM)");

  await click(chip);
  const note = container.querySelector('[role="note"]')!;
  expect(note.textContent).toContain("Effort is set to Max outside PPM");
  expect([...note.querySelectorAll("code")].map((c) => c.textContent)).toEqual(["CLAUDE_CODE_EFFORT_LEVEL=max", "~/.claude/settings.json"]);
  // The pick keeps its place; the level that actually runs is the one marked.
  expect(effortRow(container, "Max")!.textContent).toContain("In effect");
  expect(effortRow(container, "High")!.textContent).not.toContain("In effect");
});

it("shows the pick as before when nothing overrides it", async () => {
  const container = await render(null);
  const chip = container.querySelector("button")!;
  expect(chip.textContent).toBe("Opus 5.5 · High");
  await click(chip);
  expect(container.querySelector('[role="note"]')).toBeNull();
  expect(container.textContent).not.toContain("In effect");
});
