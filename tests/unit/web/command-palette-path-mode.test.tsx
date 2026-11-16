/**
 * Path mode as it rendered for a pasted folder of screenshots: every row was cut to
 * `NX-6641-pass-ie-manual-…`, carried the same parent path, and drew the same folder icon, so
 * the files could only be picked blind. These pin what replaced that: the directory once above
 * the list, whole names, each file's own type icon, folders that look like folders and step in.
 */
import { afterAll, afterEach, expect, it, spyOn } from "bun:test";
import { installDom, uninstallDom, mount, click } from "../../helpers/react-dom";

installDom();
const { act } = await import("react");
const { CommandPalette } = await import("../../../src/web/components/layout/command-palette");
const { useTabStore } = await import("../../../src/web/stores/tab-store");
const apiClient = await import("../../../src/web/lib/api-client");

afterAll(uninstallDom);

const DIR = "C:\\Users\\PC\\.agents\\skills\\nxsys-e2e-test\\evidence\\NX-6641";
const NAMES = [
  "NX-6641-pass-ie-manual-draft-result-261116.png",
  "NX-6641-pass-ie-manual-generate-261116.png",
  "NX-6641-pass-uk-dashboard-261116.png",
];
const LISTING = { dir: DIR, dirs: [`${DIR}\\raw`], files: NAMES.map((n) => `${DIR}\\${n}`) };

let get: ReturnType<typeof spyOn>;
afterEach(() => get?.mockRestore());

async function openWith(query: string) {
  get = spyOn(apiClient.api, "get").mockResolvedValue(LISTING as never);
  const view = await mount(<CommandPalette open onClose={() => {}} initialQuery={query} />);
  await act(async () => { await Promise.resolve(); });
  const rows = () => [...view.container.querySelectorAll<HTMLButtonElement>("button[data-path-entry]")];
  const input = () => view.container.querySelector("input")!;
  return { view, rows, input };
}

it("names the directory once and every file by its whole name and own type icon", async () => {
  const { view, rows } = await openWith(`${DIR}\\`);
  try {
    expect(view.container.querySelector("[data-testid=palette-path-dir]")?.textContent).toBe(DIR);
    expect(rows().map((r) => r.textContent)).toEqual(["raw", ...NAMES]);
    // The parent is not repeated on the rows; it is only in the tooltip.
    for (const row of rows()) expect(row.textContent).not.toContain("evidence");
    const [folder, ...files] = rows();
    expect(folder!.dataset.pathEntry).toBe("folder");
    expect(folder!.querySelector("[class*=vsi-]")!.className).toMatch(/vsi-[a-z-]*folder/);
    for (const [i, file] of files.entries()) {
      expect(file.dataset.pathEntry).toBe("file");
      expect(file.title).toBe(`${DIR}\\${NAMES[i]}`);
      expect(file.querySelector("[class*=vsi-]")!.className).toContain("vsi-file-type-image");
    }
  } finally {
    await view.unmount();
  }
});

it("lists only the file a full path names, and opens it", async () => {
  const open = spyOn(useTabStore.getState(), "openTab").mockReturnValue("tab-1");
  const { view, rows } = await openWith(`${DIR}\\${NAMES[1]}`);
  try {
    expect(rows().map((r) => r.textContent)).toEqual([NAMES[1]]);
    await click(rows()[0]!);
    expect(open).toHaveBeenCalledWith(expect.objectContaining({
      type: "editor", metadata: expect.objectContaining({ filePath: `${DIR}\\${NAMES[1]}` }),
    }));
  } finally {
    await view.unmount(); open.mockRestore();
  }
});

it("reads a path pasted with Copy as path's quotes", async () => {
  const { view, rows } = await openWith(`"${DIR}\\${NAMES[2]}"`);
  try {
    expect(rows().map((r) => r.textContent)).toEqual([NAMES[2]]);
  } finally {
    await view.unmount();
  }
});

it("steps into a folder instead of opening it", async () => {
  const { view, rows, input } = await openWith(`${DIR}\\`);
  try {
    await click(rows()[0]!);
    expect(input().value).toBe(`${DIR}\\raw\\`);
  } finally {
    await view.unmount();
  }
});

it("never shows one directory's listing under another, whichever answers last", async () => {
  // Two directories asked for in turn; the first answers only after the second.
  const pending = new Map<string, (listing: unknown) => void>();
  get = spyOn(apiClient.api, "get").mockImplementation(((url: string) =>
    new Promise((done) => pending.set(decodeURIComponent(url.split("dir=")[1]!.split("&")[0]!), done))) as never);
  const view = await mount(<CommandPalette open onClose={() => {}} initialQuery={"C:\\slow\\"} />);
  const input = view.container.querySelector("input")!;
  const header = () => view.container.querySelector("[data-testid=palette-path-dir]")?.textContent ?? null;
  const rows = () => [...view.container.querySelectorAll<HTMLButtonElement>("button[data-path-entry]")];
  try {
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, "C:\\fast\\");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { pending.get("C:\\fast\\")!({ dir: "C:\\fast", dirs: ["C:\\fast\\inner"], files: ["C:\\fast\\f.txt"] }); });
    await act(async () => { pending.get("C:\\slow\\")!({ dir: "C:\\slow", dirs: ["C:\\slow\\other"], files: ["C:\\slow\\s.txt"] }); });
    expect(header()).toBe("C:\\fast");
    expect(rows().map((r) => r.textContent)).toEqual(["inner", "f.txt"]);
    await click(rows()[0]!);
    expect(input.value).toBe("C:\\fast\\inner\\");
    // The next directory has not answered: nothing from the last one is offered meanwhile.
    expect(header()).toBeNull();
    expect(rows()).toEqual([]);
  } finally {
    await view.unmount();
  }
});
