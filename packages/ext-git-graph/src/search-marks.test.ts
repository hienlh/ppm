/**
 * A search in the loaded commits stays on the commits it found.
 *
 * The matches were kept as row positions and put back on the rows each time the
 * list was drawn again — which it is while a search is open, whenever the
 * uncommitted row comes or goes or the history is read again. A row added above
 * shifted every match down one, onto a commit that did not match, and stepping
 * to the next match selected that commit.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { openPanelPage, type PanelPage } from "./panel-test-harness.ts";

const hash = (i: number) => String(i).padStart(40, "0");

function commit(i: number, message: string) {
  return {
    hash: hash(i), parents: i > 1 ? [hash(i - 1)] : [], author: "T", authorEmail: "t@e.x",
    authorDate: 1_700_000_000 + i, committer: "T", committerEmail: "t@e.x", commitDate: 1_700_000_000 + i,
    refs: [], message,
  };
}

let page: PanelPage;
afterEach(() => page.close());

const marked = (cls: string) => [...page.document.querySelectorAll(`#commit-list .commit-row.${cls}`)].map((r) => (r as HTMLElement).dataset.hash);

describe("a kept search", () => {
  it("stays on the commits it found when a row is drawn above them", () => {
    page = openPanelPage();
    page.send({ command: "loadCommits", data: [commit(3, "fix the parser"), commit(2, "add docs"), commit(1, "fix the build")], append: false, skip: 0, scope: "all" });
    page.read("doSearch")("fix");
    page.read("navigateSearch")(1);
    expect(marked("search-match")).toEqual([hash(3), hash(1)]);
    expect(marked("find-current")).toEqual([hash(3)]);

    // Changes in the working tree: the uncommitted row appears on top.
    page.send({
      command: "loadChanges",
      data: { branch: { head: "main", oid: hash(3), ahead: 0, behind: 0 }, files: [{ path: "a.txt", index: ".", workingTree: "M" }] },
    });
    expect(page.document.querySelector("#commit-list .commit-row.wip")).not.toBeNull();
    expect(marked("search-match")).toEqual([hash(3), hash(1)]);
    expect(marked("find-current")).toEqual([hash(3)]);
    // The scrollbar's ticks too: rows two and four of four.
    const ticks = [...page.document.querySelectorAll("#scroll-markers .sm-search")].map((el) => (el as HTMLElement).style.top);
    expect(ticks).toEqual(["37.5%", "87.5%"]);

    page.read("navigateSearch")(1);
    expect(marked("find-current")).toEqual([hash(1)]);
    expect(page.read("state").selectedCommit).toBe(hash(1));
  });
});
