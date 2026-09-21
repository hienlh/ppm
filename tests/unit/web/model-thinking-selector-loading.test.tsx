import { afterAll, afterEach, expect, it, spyOn } from "bun:test";
import { installDom, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom";

installDom();
afterAll(uninstallDom);
const { act, useState } = await import("react");
const { api } = await import("../../../src/web/lib/api-client");
const { ModelThinkingSelector } = await import("../../../src/web/components/chat/model-thinking-selector");
let view: Mounted | undefined;
let restore: (() => void) | undefined;
afterEach(async () => { await view?.unmount(); restore?.(); });

function deferred() {
  let resolve!: (models: { value: string; label: string }[]) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<{ value: string; label: string }[]>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const claudeModels = [{ value: "opus", label: "Claude Opus" }, { value: "sonnet", label: "Claude Sonnet" }];
const codexModels = [{ value: "gpt", label: "GPT Codex" }, { value: "mini", label: "GPT Mini" }];

async function setup() {
  const claude = deferred();
  const codex = deferred();
  const spy = spyOn(api, "get").mockImplementation(((url: string) => url.includes("/claude/") ? claude.promise : codex.promise) as typeof api.get);
  restore = () => spy.mockRestore();
  let change!: (provider: string) => void;
  function Harness() {
    const [provider, setProvider] = useState("claude");
    change = setProvider;
    return <ModelThinkingSelector model={null} effort={null} thinking={false}
      onModelChange={() => {}} onEffortChange={() => {}} onThinkingChange={() => {}}
      projectName="demo" providerId={provider} />;
  }
  view = await mount(<Harness />);
  await click(view.container.querySelector("button"));
  return { claude, codex, container: view.container, switchProvider: () => act(async () => { change("codex"); }) };
}

it("removes Claude options while Codex models load, then shows Codex", async () => {
  const t = await setup();
  await act(async () => { t.claude.resolve(claudeModels); });
  expect(t.container.textContent).toContain("Sonnet");
  await t.switchProvider();
  expect(t.container.textContent).not.toContain("Sonnet");
  expect(t.container.textContent).toContain("Loading models");
  await act(async () => { t.codex.resolve(codexModels); });
  expect(t.container.textContent).toContain("GPT Codex");
  expect(t.container.textContent).not.toContain("Loading models");
});

it("ignores an old provider response arriving after the current response", async () => {
  const t = await setup();
  await t.switchProvider();
  await act(async () => { t.codex.resolve(codexModels); });
  await act(async () => { t.claude.resolve(claudeModels); });
  expect(t.container.textContent).toContain("GPT Codex");
  expect(t.container.textContent).not.toContain("Sonnet");
});

it("shows a load error instead of keeping the previous provider's options", async () => {
  const t = await setup();
  await act(async () => { t.claude.resolve(claudeModels); });
  await t.switchProvider();
  await act(async () => { t.codex.reject(new Error("offline")); });
  expect(t.container.textContent).not.toContain("Sonnet");
  expect(t.container.textContent).toContain("Unable to load models");
});
