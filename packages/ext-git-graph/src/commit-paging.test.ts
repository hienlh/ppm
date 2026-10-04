/**
 * Paging through a long history while the list is read again under it.
 *
 * Commits went missing two ways. A re-read — HEAD moved, View → Refresh, a
 * write from the panel — asked for the first page only, so every commit
 * scrolled into view vanished from under the reader. And a page asked for
 * before such a re-read could land after it: appended to the new, shorter
 * list, it left a gap in the history that the graph then drew straight across.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openPanelHost, openPanelPage, type PanelHost, type PanelPage } from "./panel-test-harness.ts";

/** A straight history, newest first: c<from> … c<to>. */
function commits(from: number, to: number) {
  const list = [];
  for (let i = from; i >= to; i--) {
    list.push({
      hash: String(i).padStart(40, "0"), parents: i > 1 ? [String(i - 1).padStart(40, "0")] : [],
      author: "T", authorEmail: "t@e.x", authorDate: 1_700_000_000 + i, committer: "T", committerEmail: "t@e.x",
      commitDate: 1_700_000_000 + i, refs: [], message: `c${i}`,
    });
  }
  return list;
}

describe("the panel", () => {
  let page: PanelPage;
  afterEach(() => page.close());

  const messages = () => page.read("state").commits.map((c: { message: string }) => c.message);

  function pagedTo(total: number) {
    page = openPanelPage();
    page.send({ command: "loadSettings", data: { ...page.read("state").settings, maxCommits: 2 } });
    page.send({ command: "loadCommits", data: commits(10, 9), append: false, skip: 0, scope: "all" });
    for (let at = 2; at < total; at += 2) {
      page.send({ command: "loadCommits", data: commits(10 - at, 9 - at), append: true, skip: at, scope: "all" });
    }
  }

  it("drops a page that does not continue the list it holds", () => {
    pagedTo(4);
    // Asked for while four were loaded; the list was read again since, as two.
    page.send({ command: "loadCommits", data: commits(10, 9), append: false, skip: 0, scope: "all" });
    page.send({ command: "loadCommits", data: commits(6, 5), append: true, skip: 4, scope: "all" });
    expect(messages()).toEqual(["c10", "c9"]);

    page.send({ command: "loadCommits", data: commits(8, 7), append: true, skip: 2, scope: "all" });
    expect(messages()).toEqual(["c10", "c9", "c8", "c7"]);
  });

  it("reads again as many commits as it has paged in: when HEAD moves, on Refresh, when the ordering changes", () => {
    pagedTo(6);
    expect(messages()).toHaveLength(6);
    const asked = () => page.posted.filter((m) => m.command === "requestCommits").map((m) => m.maxCommits);

    page.send({ command: "loadChanges", data: { branch: { head: "main", oid: "f".repeat(40), ahead: 0, behind: 0 }, files: [] } });
    page.read("reloadEverything")();
    const firstParent = page.document.getElementById("s-firstParentOnly") as HTMLInputElement;
    firstParent.checked = true;
    firstParent.dispatchEvent(new page.window.Event("change") as unknown as Event);

    expect(asked()).toEqual([6, 6, 6]);
  });
});

describe("the host", () => {
  let host: PanelHost;
  afterEach(() => host.close());

  it("says where each page goes, and reads again as many commits as it has sent", async () => {
    host = await openPanelHost();
    for (let i = 2; i <= 5; i++) {
      writeFileSync(join(host.repo, "a.txt"), `${i}\n`);
      host.git("commit", "-qam", `c${i}`);
    }
    const list = () => host.sent("loadCommits").at(-1)!;
    // Pages of two; changing the setting reads the first one.
    host.send({ command: "updateSetting", key: "maxCommits", value: 2 });
    await host.until(() => list().data.length === 2);
    host.send({ command: "requestCommits", maxCommits: 2, skip: 2 });
    await host.until(() => list().append === true);
    expect([list().skip, list().data.length]).toEqual([2, 2]);

    // A write from the panel: the host reads the history again by itself.
    const lists = host.sent("loadCommits").length;
    host.send({ command: "gitAction", action: "createTag", args: { name: "v1" } });
    await host.until(() => host.sent("loadCommits").length > lists);
    expect([list().append, list().skip, list().data.length]).toEqual([false, 0, 4]);
  });
});
