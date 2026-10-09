/**
 * The PPM Assistant always asks before it changes anything — the server forces that — so its
 * composer must not offer a permission mode it cannot have: the chip shows "ask first",
 * disabled, with the reason, and neither a click nor Shift+Tab changes it. Its virtual
 * project has no files either, so `@` opens no file picker and fetches no file index.
 */
import { afterAll, afterEach, expect, it, spyOn } from "bun:test";
import { act } from "react";
import { installDom, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom";

installDom();
afterAll(uninstallDom);
const { MessageInput } = await import("../../../src/web/components/chat/message-input");
const { api } = await import("../../../src/web/lib/api-client");

let view: Mounted | null = null;
const spies: Array<{ mockRestore(): void }> = [];
afterEach(async () => {
  await view?.unmount();
  view = null;
  for (const spy of spies.splice(0)) spy.mockRestore();
});

function stubGet() {
  const get = spyOn(api, "get").mockImplementation(((path: string) =>
    Promise.resolve(path.includes("/chat/slash-items") ? { items: [], recentNames: [] } : [])) as typeof api.get);
  spies.push(get);
  return () => get.mock.calls.map((call) => String(call[0]));
}

const chips = () => [...view!.container.querySelectorAll("button[aria-label^='Permission mode']")];

it("shows the ask-first mode, disabled with its reason, whatever the metadata says", async () => {
  stubGet();
  const modes: string[] = [];
  view = await mount(<MessageInput projectName="__assistant__" onSend={() => {}} permissionMode="bypassPermissions"
    permissionLocked onModeChange={(m) => modes.push(m)} />);
  expect(chips().length).toBeGreaterThan(0);
  for (const chip of chips()) {
    expect(chip.getAttribute("aria-disabled")).toBe("true");
    expect(chip.getAttribute("aria-label")).toContain("Ask before edits");
    expect(chip.getAttribute("title")).toContain("always asks");
  }
  await click(chips()[0]!);
  expect(view.container.querySelector("[aria-label='Permission modes']")).toBeNull();

  const textarea = view.container.querySelector("textarea")!;
  await act(async () => {
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
  });
  expect(modes).toEqual([]);
});

it("still opens the mode picker in an ordinary chat", async () => {
  stubGet();
  view = await mount(<MessageInput projectName="ppm" onSend={() => {}} permissionMode="default" onModeChange={() => {}} />);
  for (const chip of chips()) expect(chip.getAttribute("aria-disabled")).toBeNull();
  await click(chips()[0]!);
  expect(view.container.querySelector("[aria-label='Permission modes']")).not.toBeNull();
});

it("opens no file picker and fetches no file index on @ when file mentions are off", async () => {
  const calls = stubGet();
  const states: Array<[boolean, string]> = [];
  view = await mount(<MessageInput projectName="__assistant__" onSend={() => {}} fileMentions={false}
    onFileStateChange={(visible, filter) => states.push([visible, filter])} />);
  const textarea = view.container.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "@src");
    textarea.setSelectionRange(4, 4);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(states.some(([visible]) => visible)).toBe(false);
  expect(calls().filter((path) => path.includes("/files/"))).toEqual([]);
});
