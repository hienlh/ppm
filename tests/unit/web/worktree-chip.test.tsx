/**
 * The footer's worktree chip: a switch before a new Claude chat's first message, nothing once
 * the choice is gone, and the branch name once the chat runs in a worktree.
 */
import { afterAll, afterEach, expect, it } from "bun:test";
import { installDom, uninstallDom, mount, click, type Mounted } from "../../helpers/react-dom";

installDom();
afterAll(uninstallDom);
const { useState } = await import("react");
const { WorktreeChip } = await import("../../../src/web/components/chat/worktree-chip");

let view: Mounted | undefined;
afterEach(async () => { await view?.unmount(); view = undefined; });

const chip = () => view!.container.querySelector("[data-worktree-chip]");

function Switch() {
  const [wanted, setWanted] = useState(false);
  return <WorktreeChip worktree={null} canChoose wanted={wanted} onWantedChange={setWanted} />;
}

it("toggles the choice before the first message", async () => {
  view = await mount(<Switch />);
  expect(chip()?.getAttribute("data-worktree-chip")).toBe("off");
  expect(chip()?.getAttribute("aria-pressed")).toBe("false");
  await click(chip());
  expect(chip()?.getAttribute("data-worktree-chip")).toBe("wanted");
  expect(chip()?.getAttribute("aria-pressed")).toBe("true");
  expect(chip()?.textContent).toContain("New worktree");
});

it("shows nothing when the chat can no longer choose", async () => {
  view = await mount(<WorktreeChip worktree={null} canChoose={false} wanted={false} onWantedChange={() => {}} />);
  expect(chip()).toBeNull();
});

it("names the branch once the chat runs in a worktree", async () => {
  const worktree = { name: "chat-1", path: "/p/.claude/worktrees/chat-1", branch: "worktree-chat-1" };
  view = await mount(<WorktreeChip worktree={worktree} canChoose={false} wanted={false} onWantedChange={() => {}} />);
  expect(chip()?.getAttribute("data-worktree-chip")).toBe("on");
  expect(chip()?.textContent).toBe("worktree-chat-1");
  expect(chip()?.getAttribute("title")).toContain(worktree.path);
});
