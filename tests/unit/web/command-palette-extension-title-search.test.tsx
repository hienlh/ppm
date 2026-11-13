/**
 * An extension command's search text used to be its `keywords` ALONE
 * (`extension <command id> <category>`), never its displayed title — so typing the command's id
 * ("futureGraph.open") found it, but typing the title shown in the list itself
 * ("Đồ thị tương lai: Mở") found nothing. Fixed by folding the label into the search path for
 * every command that has `keywords` (`command-palette.tsx`'s `searchIndex`).
 */
import { afterAll, afterEach, beforeEach, expect, it } from "bun:test";
import { installDom, uninstallDom, mount } from "../../helpers/react-dom";

installDom();
afterAll(uninstallDom);
const { CommandPalette } = await import("../../../src/web/components/layout/command-palette");
const { useExtensionStore } = await import("../../../src/web/stores/extension-store");
const apiClient = await import("../../../src/web/lib/api-client");

const command = { command: "futureGraph.open", title: "Đồ thị tương lai: Mở", category: "Future Graph" };

// The store is process-wide across test files, so the real contributions (if any) are restored.
let before: ReturnType<typeof useExtensionStore.getState>["contributions"];
beforeEach(() => {
  before = useExtensionStore.getState().contributions;
  useExtensionStore.getState().setContributions({ commands: [command] });
});
afterEach(() => {
  useExtensionStore.setState({ contributions: before });
});

async function search(query: string) {
  const { spyOn } = await import("bun:test");
  const get = spyOn(apiClient.api, "get").mockResolvedValue([] as never);
  const view = await mount(<CommandPalette open onClose={() => {}} initialQuery={query} />);
  return { view, async done() { await view.unmount(); get.mockRestore(); } };
}

it("finds a contributed command by its displayed title, not only by its id", async () => {
  const s = await search("Đồ thị tương lai");
  try {
    const row = [...s.view.container.querySelectorAll("button")].find((b) => b.textContent?.includes(command.title));
    expect(row).toBeTruthy();
  } finally {
    await s.done();
  }
});

it("still finds it by a word from the title alone, case-insensitively", async () => {
  const s = await search("mở");
  try {
    const row = [...s.view.container.querySelectorAll("button")].find((b) => b.textContent?.includes(command.title));
    expect(row).toBeTruthy();
  } finally {
    await s.done();
  }
});

it("still finds it by its command id, as before (keywords are additive, not replaced)", async () => {
  const s = await search("futureGraph");
  try {
    const row = [...s.view.container.querySelectorAll("button")].find((b) => b.textContent?.includes(command.title));
    expect(row).toBeTruthy();
  } finally {
    await s.done();
  }
});

it("dispatches the right command id when the title-matched row is clicked", async () => {
  const { click } = await import("../../helpers/react-dom");
  const asked: unknown[] = [];
  const listen = (e: Event) => asked.push((e as CustomEvent).detail);
  window.addEventListener("ext:command:execute", listen);
  const s = await search("tương lai"); // found only via the title, never via keywords
  try {
    const row = [...s.view.container.querySelectorAll("button")].find((b) => b.textContent?.includes(command.title));
    await click(row ?? null);
    expect(asked).toEqual([{ command: "futureGraph.open", args: [] }]);
  } finally {
    window.removeEventListener("ext:command:execute", listen);
    await s.done();
  }
});
