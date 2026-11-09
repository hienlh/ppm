/**
 * The composer's `/` and `@` pickers as a floating popover: what each row shows, the `/` filter
 * tabs, and that the keyboard still drives them exactly as before (arrows, Enter, Tab, Esc,
 * recents first).
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { installDom, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom";

installDom();
afterAll(uninstallDom);
const { SlashCommandPicker } = await import("../../../src/web/components/chat/slash-command-picker");
import type { SlashItem } from "../../../src/web/components/chat/slash-command-picker";
const { slashScopeLabel } = await import("../../../src/web/components/chat/slash-command-picker-row");
const { FilePicker, splitFilePath } = await import("../../../src/web/components/chat/file-picker");
import type { FileNode } from "../../../src/types/project";

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const ITEMS: SlashItem[] = [
  { type: "skill", name: "ak-research", description: "Research technical solutions.", argumentHint: "[topic]", scope: "user" },
  { type: "agent", name: "Explore", description: "Fast read-only search.", scope: "bundled" },
  { type: "command", name: "deploy-staging", description: "Deploy to staging.", scope: "project" },
  { type: "builtin", name: "compact", description: "Summarize the conversation.", scope: "bundled" },
];

async function key(k: string) {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
}

function rows(): HTMLElement[] {
  return [...view!.container.querySelectorAll<HTMLElement>('[role="option"]')];
}

describe("slash picker", () => {
  it("floats above the composer with the popover surface and motion", async () => {
    view = await mount(<SlashCommandPicker items={ITEMS} filter="" visible onSelect={() => {}} onClose={() => {}} />);
    const panel = view.container.querySelector<HTMLElement>("[data-composer-picker]")!;
    expect(panel.getAttribute("data-composer-picker")).toBe("floating");
    for (const cls of ["absolute", "bottom-full", "mb-1.5", "inset-x-0", "rounded-xl", "popover-solid", "footer-pop-in", "shadow-[var(--shadow-float)]"]) {
      expect(panel.className.split(/\s+/)).toContain(cls);
    }
    expect(panel.className).toContain("max-h-[min(320px,55vh)]");
    expect(view.container.querySelector('[role="listbox"]')!.className).toContain("overflow-y-auto");
  });

  it("is static (in flow, no motion) when asked", async () => {
    view = await mount(<SlashCommandPicker items={ITEMS} filter="" visible variant="static" onSelect={() => {}} onClose={() => {}} />);
    const panel = view.container.querySelector<HTMLElement>("[data-composer-picker]")!;
    expect(panel.getAttribute("data-composer-picker")).toBe("static");
    expect(panel.className).not.toContain("absolute");
    expect(panel.className).not.toContain("footer-pop-in");
  });

  it("tints each type's tile, tags the scope, and marks the typed match in the name", async () => {
    view = await mount(<SlashCommandPicker items={ITEMS} filter="research" visible onSelect={() => {}} onClose={() => {}} />);
    const row = rows()[0]!;
    expect(row.textContent).toContain("/ak-research");
    expect(row.querySelector("mark")!.textContent).toBe("research");
    expect(row.querySelector("mark")!.className).toContain("bg-transparent");
    expect(row.querySelector("mark")!.className).toContain("text-primary");
    expect(row.firstElementChild!.className).toContain("text-accent-2");
    expect(row.textContent).toContain("Global");
    const hint = [...row.querySelectorAll("span")].find((s) => s.textContent === "[topic]")!;
    expect(hint.className).toContain("font-mono");
    expect(hint.className).toContain("@max-[420px]/chat:hidden");
  });

  it("labels scopes Global / Project / PPM, and Codex for a $ skill", () => {
    expect(slashScopeLabel(ITEMS[0]!)).toBe("Global");
    expect(slashScopeLabel(ITEMS[2]!)).toBe("Project");
    expect(slashScopeLabel(ITEMS[3]!)).toBe("PPM");
    expect(slashScopeLabel({ ...ITEMS[0]!, invokeSigil: "$" })).toBe("Codex");
  });

  it("keeps a runtime-supplied icon", async () => {
    const withIcon = [{ ...ITEMS[0]!, iconDataUri: "data:image/png;base64,AA==" }];
    view = await mount(<SlashCommandPicker items={withIcon} filter="" visible onSelect={() => {}} onClose={() => {}} />);
    expect(rows()[0]!.querySelector("img")!.getAttribute("src")).toBe("data:image/png;base64,AA==");
  });

  it("clamps the description to one line, two only on the selected row", async () => {
    view = await mount(<SlashCommandPicker items={ITEMS} filter="" visible onSelect={() => {}} onClose={() => {}} />);
    const desc = (r: HTMLElement) => [...r.querySelectorAll("span")].find((s) => s.textContent === ITEMS[rows().indexOf(r)]!.description)!;
    expect(desc(rows()[0]!).className).toContain("line-clamp-2");
    expect(desc(rows()[1]!).className).toContain("truncate");
    expect(desc(rows()[1]!).className).not.toContain("line-clamp-2");
  });

  it("filters by tab — Commands covers built-ins — and an empty tab keeps the panel open without picking", async () => {
    const picked: string[] = [];
    view = await mount(<SlashCommandPicker items={ITEMS.slice(0, 3)} filter="" visible onSelect={(i) => picked.push(i.name)} onClose={() => {}} />);
    const tab = (label: string) => [...view!.container.querySelectorAll('[role="tab"]')].find((t) => t.textContent === label)!;
    expect([...view.container.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).toEqual(["All", "Skills", "Commands", "Agents"]);
    await click(tab("Agents"));
    expect(tab("Agents").getAttribute("aria-selected")).toBe("true");
    expect(rows().map((r) => r.textContent)).toEqual([expect.stringContaining("/Explore")]);
    await view.rerender(<SlashCommandPicker items={ITEMS} filter="" visible onSelect={(i) => picked.push(i.name)} onClose={() => {}} />);
    await click(tab("Commands"));
    expect(rows()).toHaveLength(2);
    expect(rows()[0]!.textContent).toContain("/deploy-staging");
    expect(rows()[1]!.textContent).toContain("/compact");
    // A query that matches only in another tab: the panel stays, Enter picks nothing.
    await view.rerender(<SlashCommandPicker items={ITEMS} filter="research" visible onSelect={(i) => picked.push(i.name)} onClose={() => {}} />);
    expect(rows()).toHaveLength(0);
    expect(view.container.textContent).toContain("No skill or command matches.");
    await key("Enter");
    expect(picked).toEqual([]);
  });

  it("closes (renders nothing) when the query matches nothing at all", async () => {
    view = await mount(<SlashCommandPicker items={ITEMS} filter="zzzzzzzzzzqqqq" visible onSelect={() => {}} onClose={() => {}} />);
    expect(view.container.querySelector("[data-composer-picker]")).toBeNull();
  });

  it("shows recents first under Recent, then All, and the keyboard moves, picks and closes as before", async () => {
    const picked: string[] = [];
    let closed = 0;
    view = await mount(<SlashCommandPicker items={ITEMS} filter="" visible recentNames={["compact", "Explore"]}
      onSelect={(i) => picked.push(i.name)} onClose={() => { closed++; }} />);
    expect(rows().map((r) => r.getAttribute("data-picker-index"))).toEqual(["0", "1", "2", "3"]);
    expect(rows()[0]!.textContent).toContain("/compact");
    expect(rows()[1]!.textContent).toContain("/Explore");
    expect(view.container.textContent).toContain("Recent");
    expect(view.container.textContent).toContain("All");
    await key("ArrowDown");
    expect(rows()[1]!.getAttribute("aria-selected")).toBe("true");
    await key("Enter");
    expect(picked).toEqual(["Explore"]);
    await key("ArrowUp");
    await key("ArrowUp");
    await key("Tab"); // up from the second row wraps past the top to the last
    expect(picked).toEqual(["Explore", "deploy-staging"]);
    await key("Escape");
    expect(closed).toBe(1);
  });

  it("puts key hints in the footer, hidden on narrow and touch", async () => {
    view = await mount(<SlashCommandPicker items={ITEMS} filter="" visible onSelect={() => {}} onClose={() => {}} />);
    const hints = view.container.querySelector<HTMLElement>("[data-picker-key-hints]")!;
    expect(hints.textContent).toBe("↑↓ move↵ insertTab completeEsc close");
    for (const cls of ["@max-[420px]/chat:hidden", "max-md:hidden", "[@media(hover:none)]:hidden", "flex-wrap"]) {
      expect(hints.className.split(/\s+/)).toContain(cls);
    }
  });
});

const FILES: FileNode[] = [
  { name: "chat-tab.tsx", path: "src/web/components/chat/chat-tab.tsx", type: "file" },
  { name: "chat", path: "src/web/components/chat", type: "directory" },
  { name: "README.md", path: "README.md", type: "file" },
] as FileNode[];

describe("file picker", () => {
  it("splits a path into a name and its directory, a folder's name keeping its slash", () => {
    expect(splitFilePath(FILES[0]!)).toEqual({ name: "chat-tab.tsx", dir: "src/web/components/chat/" });
    expect(splitFilePath(FILES[1]!)).toEqual({ name: "chat/", dir: "src/web/components/" });
    expect(splitFilePath(FILES[2]!)).toEqual({ name: "README.md", dir: "" });
  });

  it("heads the list with the match count, sets the name in medium weight, start-ellipsises the directory and marks the match", async () => {
    view = await mount(<FilePicker items={FILES} filter="chat" visible onSelect={() => {}} onClose={() => {}} />);
    expect(view.container.textContent).toContain("Files");
    expect(view.container.textContent).toContain("2 matches for “chat”");
    const [file, dir] = rows();
    expect(file!.querySelector(".font-medium")!.textContent).toBe("chat-tab.tsx");
    expect(file!.querySelector("mark")!.textContent).toBe("chat");
    const ellipsis = file!.querySelector('[dir="rtl"]')!;
    expect(ellipsis.querySelector("bdi")!.textContent).toBe("src/web/components/chat/");
    expect(dir!.textContent).toContain("chat/");
    expect(dir!.firstElementChild!.className).toContain("text-warning");
    expect(file!.firstElementChild!.className).not.toContain("text-warning");
  });

  it("wraps the directory under the name and keeps 44px rows on narrow and touch", async () => {
    view = await mount(<FilePicker items={FILES} filter="" visible onSelect={() => {}} onClose={() => {}} />);
    expect(view.container.textContent).toContain("3 matches");
    const row = rows()[0]!;
    expect(row.className).toContain("@max-[420px]/chat:min-h-11");
    expect(row.className).toContain("max-md:grid-cols-[24px_minmax(0,1fr)]");
    expect((row.lastElementChild as HTMLElement).className).toContain("@max-[420px]/chat:col-start-2");
  });

  it("moves, picks and closes from the keyboard as before", async () => {
    const picked: string[] = [];
    let closed = 0;
    view = await mount(<FilePicker items={FILES} filter="" visible onSelect={(f) => picked.push(f.path)} onClose={() => { closed++; }} />);
    await key("ArrowDown");
    await key("Enter");
    expect(picked).toEqual(["src/web/components/chat"]);
    await key("ArrowUp");
    await key("ArrowUp");
    await key("Tab");
    expect(picked).toEqual(["src/web/components/chat", "README.md"]);
    await key("Escape");
    expect(closed).toBe(1);
  });
});
